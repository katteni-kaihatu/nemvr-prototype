use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use space_protocol::messages::{ClientMessage, ServerMessage};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub server: String,
    pub name: String,
    pub session_id: String,
}

#[derive(Debug)]
pub enum NetCommand {
    Connect(ConnectOptions),
    Send(ClientMessage),
}

#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub enum NetEvent {
    Connected,
    Message(ServerMessage),
    Disconnected(String),
    Error(String),
}

#[derive(bevy::prelude::Resource)]
pub struct NetHandle {
    pub commands: UnboundedSender<NetCommand>,
    events: Mutex<UnboundedReceiver<NetEvent>>,
}

impl NetHandle {
    pub fn spawn(initial: Option<ConnectOptions>) -> Self {
        let (command_tx, command_rx) = unbounded_channel();
        let (event_tx, event_rx) = unbounded_channel();

        thread::Builder::new()
            .name("proto-client-net".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                runtime.block_on(run_actor(initial, command_rx, event_tx));
            })
            .expect("spawn network thread");

        Self {
            commands: command_tx,
            events: Mutex::new(event_rx),
        }
    }

    pub fn poll(&self) -> Vec<NetEvent> {
        let mut events = Vec::new();
        let mut receiver = self.events.lock().expect("net events lock");
        while let Ok(event) = receiver.try_recv() {
            events.push(event);
        }
        events
    }

    pub fn send(&self, message: ClientMessage) -> bool {
        self.commands.send(NetCommand::Send(message)).is_ok()
    }

    pub fn connect(&self, options: ConnectOptions) {
        self.commands.send(NetCommand::Connect(options)).ok();
    }
}

enum SessionEnd {
    Reconnect,
    Switch(ConnectOptions),
    Stop,
}

async fn run_actor(
    initial: Option<ConnectOptions>,
    mut commands: UnboundedReceiver<NetCommand>,
    events: UnboundedSender<NetEvent>,
) {
    let mut next = initial;
    let mut backoff = Duration::from_millis(250);

    loop {
        let Some(options) = next.take() else {
            match commands.recv().await {
                Some(NetCommand::Connect(options)) => next = Some(options),
                Some(NetCommand::Send(_)) => {}
                None => return,
            }
            continue;
        };

        let result = session(&options, &mut commands, &events).await;
        match result {
            SessionEnd::Switch(options) => {
                backoff = Duration::from_millis(250);
                next = Some(options);
            }
            SessionEnd::Stop => {
                let _ = events.send(NetEvent::Disconnected("切断しました".into()));
            }
            SessionEnd::Reconnect => {
                events
                    .send(NetEvent::Disconnected(
                        "接続が切れました。再接続します".into(),
                    ))
                    .ok();
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(10));
                next = Some(options);
            }
        }
    }
}

async fn session(
    options: &ConnectOptions,
    commands: &mut UnboundedReceiver<NetCommand>,
    events: &UnboundedSender<NetEvent>,
) -> SessionEnd {
    let Ok((stream, _)) = tokio_tungstenite::connect_async(&options.server).await else {
        let _ = events.send(NetEvent::Error(format!(
            "WebSocket に接続できません: {}",
            options.server
        )));
        return SessionEnd::Reconnect;
    };

    let (mut write, mut read) = stream.split();
    let join = ClientMessage::SpaceJoin {
        name: options.name.clone(),
        session_id: if options.session_id == "main" {
            None
        } else {
            Some(options.session_id.clone())
        },
        template_id: space_protocol::SPACE_TEMPLATE_ID.into(),
        schema_version: space_protocol::SPACE_SCHEMA_VERSION,
    };

    if send_message(&mut write, &join).await.is_err() {
        return SessionEnd::Reconnect;
    }
    let _ = events.send(NetEvent::Connected);

    let mut ping = tokio::time::interval(Duration::from_secs(2));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(NetCommand::Send(message)) => {
                        if send_message(&mut write, &message).await.is_err() {
                            return SessionEnd::Reconnect;
                        }
                    }
                    Some(NetCommand::Connect(options)) => {
                        return SessionEnd::Switch(options);
                    }
                    None => return SessionEnd::Stop,
                }
            }
            message = read.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        match ServerMessage::from_json(text.as_str()) {
                            Ok(message) => {
                                let _ = events.send(NetEvent::Message(message));
                            }
                            Err(error) => {
                                let _ = events.send(NetEvent::Error(format!(
                                    "サーバーメッセージを解釈できません: {error}"
                                )));
                            }
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame
                            .map(|f| f.reason.to_string())
                            .filter(|reason| !reason.is_empty())
                            .unwrap_or_else(|| "サーバーが接続を閉じました".into());
                        let _ = events.send(NetEvent::Disconnected(reason));
                        return SessionEnd::Reconnect;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        let _ = events.send(NetEvent::Error(error.to_string()));
                        return SessionEnd::Reconnect;
                    }
                    None => {
                        let _ = events.send(NetEvent::Disconnected("接続が終了しました".into()));
                        return SessionEnd::Reconnect;
                    }
                }
            }
            _ = ping.tick() => {
                let ping = ClientMessage::SpacePing { id: unix_ms() };
                if send_message(&mut write, &ping).await.is_err() {
                    return SessionEnd::Reconnect;
                }
            }
        }
    }
}

async fn send_message<S>(write: &mut S, message: &ClientMessage) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
{
    let Ok(json) = message.to_json() else {
        return Err(());
    };
    write.send(Message::Text(json.into())).await.map_err(|_| ())
}

pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
