use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use space_protocol::messages::{ClientMessage, ServerMessage};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::watch;
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
    Send {
        generation: u64,
        message: ClientMessage,
    },
    Disconnect,
    Shutdown,
}

#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub enum NetEvent {
    Connected,
    Message(ServerMessage),
    Disconnected(String),
    Error(String),
}

pub(crate) struct NetEvents {
    sender: UnboundedSender<(u64, NetEvent)>,
    generation: u64,
}

impl NetEvents {
    pub(crate) fn send(&self, event: NetEvent) -> Result<(), ()> {
        self.sender.send((self.generation, event)).map_err(|_| ())
    }
}

pub struct NetHandle {
    pub commands: UnboundedSender<NetCommand>,
    events: Mutex<UnboundedReceiver<(u64, NetEvent)>>,
    shutdown: watch::Sender<bool>,
    generation: AtomicU64,
    worker: thread::JoinHandle<()>,
}

impl NetHandle {
    #[cfg(test)]
    pub(crate) fn test_channels() -> (Self, UnboundedReceiver<NetCommand>, NetEvents) {
        let (commands, commands_rx) = unbounded_channel();
        let (event_tx, events) = unbounded_channel();
        let (shutdown, _) = watch::channel(false);
        (
            Self {
                commands,
                events: Mutex::new(events),
                shutdown,
                generation: AtomicU64::new(1),
                worker: thread::spawn(|| {}),
            },
            commands_rx,
            NetEvents {
                sender: event_tx,
                generation: 1,
            },
        )
    }

    pub fn spawn(initial: Option<ConnectOptions>) -> Self {
        let (command_tx, command_rx) = unbounded_channel();
        let (event_tx, event_rx) = unbounded_channel();
        let (shutdown, mut shutdown_rx) = watch::channel(false);

        let worker = thread::Builder::new()
            .name("proto-client-net".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                runtime.block_on(async move {
                    tokio::select! {
                        biased;
                        _ = shutdown_rx.changed() => {},
                        _ = run_actor(initial, command_rx, event_tx) => {},
                    }
                });
            })
            .expect("spawn network thread");

        Self {
            commands: command_tx,
            events: Mutex::new(event_rx),
            shutdown,
            generation: AtomicU64::new(0),
            worker,
        }
    }

    pub fn poll(&self) -> Vec<NetEvent> {
        let mut events = Vec::new();
        let mut receiver = self.events.lock().expect("net events lock");
        for _ in 0..256 {
            match receiver.try_recv() {
                Ok((generation, event)) => {
                    // Input remains in the last observed session until its reset
                    // has reached the caller, even if the actor reconnects first.
                    if matches!(event, NetEvent::Connected) {
                        self.generation.store(generation, Ordering::Release);
                    }
                    events.push(event);
                }
                Err(_) => break,
            }
        }
        events
    }

    pub fn send(&self, message: ClientMessage) -> bool {
        self.commands
            .send(NetCommand::Send {
                generation: self.generation.load(Ordering::Acquire),
                message,
            })
            .is_ok()
    }

    pub fn connect(&self, options: ConnectOptions) {
        self.commands.send(NetCommand::Connect(options)).ok();
    }

    pub fn disconnect(&self) {
        self.commands.send(NetCommand::Disconnect).ok();
    }

    pub fn shutdown(&self) {
        self.shutdown.send(true).ok();
    }

    pub fn is_finished(&self) -> bool {
        self.worker.is_finished()
    }
}

impl Drop for NetHandle {
    fn drop(&mut self) {
        self.shutdown();
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
    event_tx: UnboundedSender<(u64, NetEvent)>,
) {
    let mut next = initial;
    let mut backoff = Duration::from_millis(250);
    let mut generation = 0;

    loop {
        let Some(options) = next.take() else {
            match commands.recv().await {
                Some(NetCommand::Connect(options)) => next = Some(options),
                Some(NetCommand::Send { .. }) => {}
                Some(NetCommand::Disconnect) => {}
                Some(NetCommand::Shutdown) | None => return,
            }
            continue;
        };

        generation += 1;
        let events = NetEvents {
            sender: event_tx.clone(),
            generation,
        };
        let result = session(&options, &mut commands, &events, generation).await;
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
                let delay = tokio::time::sleep(backoff);
                tokio::pin!(delay);
                let retry = loop {
                    tokio::select! {
                        _ = &mut delay => break Some(options.clone()),
                        command = commands.recv() => match command {
                            Some(NetCommand::Connect(options)) => break Some(options),
                            Some(NetCommand::Disconnect) => break None,
                            Some(NetCommand::Shutdown) | None => return,
                            Some(NetCommand::Send {..}) => {},
                        }
                    }
                };
                backoff = (backoff * 2).min(Duration::from_secs(10));
                next = retry;
            }
        }
    }
}

async fn session(
    options: &ConnectOptions,
    commands: &mut UnboundedReceiver<NetCommand>,
    events: &NetEvents,
    generation: u64,
) -> SessionEnd {
    let connection = tokio_tungstenite::connect_async(&options.server);
    tokio::pin!(connection);
    let result = loop {
        tokio::select! {
            result = &mut connection => break result,
            command = commands.recv() => match command {
                Some(NetCommand::Connect(options)) => return SessionEnd::Switch(options),
                Some(NetCommand::Send {..}) => {},
                _ => return SessionEnd::Stop,
            },
        }
    };
    let Ok((stream, _)) = result else {
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
                    Some(NetCommand::Send {generation: sent_generation, message}) => {
                        if sent_generation != generation {continue;}
                        if send_message(&mut write, &message).await.is_err() {
                            return SessionEnd::Reconnect;
                        }
                    }
                    Some(NetCommand::Connect(options)) => {
                        return SessionEnd::Switch(options);
                    }
                    Some(NetCommand::Disconnect | NetCommand::Shutdown) => {
                        let _ = write.close().await;
                        return SessionEnd::Stop;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn options(server: String) -> ConnectOptions {
        ConnectOptions {
            server,
            name: "test".into(),
            session_id: "main".into(),
        }
    }

    async fn wait_stopped(net: &NetHandle) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !net.is_finished() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("network shutdown must cancel connecting/backoff");
    }

    #[tokio::test]
    async fn shutdown_cancels_websocket_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let net = NetHandle::spawn(Some(options(format!(
            "ws://{}/ws",
            listener.local_addr().unwrap()
        ))));
        let (_socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        net.shutdown();
        wait_stopped(&net).await;
    }

    #[tokio::test]
    async fn shutdown_cancels_reconnect_backoff() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let net = NetHandle::spawn(Some(options(format!("ws://{address}/ws"))));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if net
                    .poll()
                    .iter()
                    .any(|event| matches!(event, NetEvent::Disconnected(_)))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        net.shutdown();
        wait_stopped(&net).await;
    }

    #[tokio::test]
    async fn stale_generation_commands_never_reach_new_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (joined_tx, joined_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut joined_tx = Some(joined_tx);
            loop {
                let message = ws.next().await.unwrap().unwrap();
                if let Message::Text(text) = message {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "space_join" {
                        joined_tx.take().unwrap().send(()).unwrap();
                    }
                    assert_ne!(value["id"], 13, "retired command replayed");
                    if value["id"] == 42 {
                        break;
                    }
                }
            }
        });
        let net = NetHandle::spawn(Some(options(format!("ws://{address}/ws"))));
        tokio::time::timeout(Duration::from_secs(5), joined_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(net.generation.load(Ordering::Acquire), 0);
        assert!(net.send(ClientMessage::SpacePing { id: 13 }));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if net
                    .poll()
                    .iter()
                    .any(|event| matches!(event, NetEvent::Connected))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        net.commands
            .send(NetCommand::Send {
                generation: 0,
                message: ClientMessage::SpacePing { id: 13 },
            })
            .unwrap();
        assert!(net.send(ClientMessage::SpacePing { id: 42 }));
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        net.shutdown();
        wait_stopped(&net).await;
    }
}
