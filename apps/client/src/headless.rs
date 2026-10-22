use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use space_protocol::messages::{ClientMessage, ServerMessage, SpaceMutation};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

pub fn run(server: String, name: String, scenario: String, duration: u64) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        if let Err(error) = run_inner(&server, &name, &scenario, duration).await {
            eprintln!("headless: {error}");
            std::process::exit(1);
        }
    });
}

async fn run_inner(server: &str, name: &str, scenario: &str, duration: u64) -> anyhow::Result<()> {
    let name = if name.is_empty() { "bot" } else { name };
    let (stream, _) = tokio_tungstenite::connect_async(server).await?;
    let (mut write, mut read) = stream.split();

    let join = ClientMessage::SpaceJoin {
        name: name.to_owned(),
        session_id: None,
        template_id: space_protocol::SPACE_TEMPLATE_ID.into(),
        schema_version: space_protocol::SPACE_SCHEMA_VERSION,
    };
    write.send(Message::Text(join.to_json()?.into())).await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(duration.max(1));
    let mut placed = false;

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            message = read.next() => {
                let Some(message) = message else { break };
                let message = message?;
                let Message::Text(text) = message else { continue };
                let Ok(message) = ServerMessage::from_json(text.as_str()) else {
                    println!("{{\"error\":\"unparsed\"}}");
                    continue;
                };

                match &message {
                    ServerMessage::SpaceWelcome { me, entities, session_id, seq, .. } => {
                        println!(
                            "{}",
                            serde_json::json!({
                                "event": "welcome",
                                "peerId": me.peer_id,
                                "entityId": me.entity_id,
                                "name": me.name,
                                "sessionId": session_id,
                                "entities": entities.len(),
                                "seq": seq,
                            })
                        );
                        if scenario.contains("place") && !placed {
                            placed = true;
                            let entity_id = Uuid::new_v4().to_string();
                            let command_id = Uuid::new_v4().to_string();
                            let dimensions = serde_json::json!({
                                "entity.kind": "box",
                                "space.position": [0.0, 0.0, -2.0],
                                "space.yaw": 0.0,
                                "box.size": 1.0,
                                "box.color": "#44aa88",
                            });
                            let mutation = SpaceMutation::Create {
                                command_id,
                                entity_id,
                                dimensions: dimensions.as_object().cloned().unwrap(),
                            };
                            let message = ClientMessage::SpaceMutate { mutation };
                            write
                                .send(Message::Text(message.to_json()?.into()))
                                .await?;
                        }
                    }
                    ServerMessage::SpaceDelta { seq, changes, .. } => {
                        println!(
                            "{}",
                            serde_json::json!({
                                "event": "delta",
                                "seq": seq,
                                "changes": changes.len(),
                            })
                        );
                    }
                    ServerMessage::SpaceAck { command_id, entity_id, .. } => {
                        println!(
                            "{}",
                            serde_json::json!({
                                "event": "ack",
                                "commandId": command_id,
                                "entityId": entity_id,
                            })
                        );
                    }
                    ServerMessage::SpaceError { code, message, .. } => {
                        println!(
                            "{}",
                            serde_json::json!({
                                "event": "error",
                                "code": code,
                                "message": message,
                            })
                        );
                    }
                    ServerMessage::SpacePong { .. } => {}
                    other => {
                        println!(
                            "{}",
                            serde_json::json!({ "event": "message", "type": format!("{:?}", std::mem::discriminant(other)) })
                        );
                    }
                }
            }
        }
    }

    let _ = write.close().await;
    Ok(())
}

pub fn ipfs_smoke() {
    #[cfg(feature = "ipfs")]
    {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async {
            let repo = crate::config::project_dirs()
                .map(|dirs| dirs.cache_dir().join("ipfs"))
                .unwrap_or_else(|| std::path::PathBuf::from("./.proto-client-ipfs"));
            match crate::content::ipfs::start(repo).await {
                Ok((node, peer_id)) => {
                    println!(
                        "{}",
                        serde_json::json!({ "event": "ipfs-ready", "peerId": peer_id })
                    );

                    if let Ok(address) = std::env::var("PROTO_KUBO_ADDR") {
                        match address.parse::<rust_ipfs::Multiaddr>() {
                            Ok(address) => match node.connect(address).await {
                                Ok(_) => {
                                    println!(
                                        "{}",
                                        serde_json::json!({ "event": "kubo-connected" })
                                    );
                                }
                                Err(error) => {
                                    eprintln!("ipfs-smoke: kuboconnect: {error}");
                                    std::process::exit(1);
                                }
                            },
                            Err(error) => {
                                eprintln!("ipfs-smoke: invalid PROTO_KUBO_ADDR: {error}");
                                std::process::exit(1);
                            }
                        }
                    }

                    if let Ok(path) = std::env::var("PROTO_ADD_FILE") {
                        let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                        if let Err(error) = crate::content::ipfs::add_file(
                            node.clone(),
                            std::path::PathBuf::from(path),
                            events,
                        )
                        .await
                        {
                            eprintln!("ipfs-smoke: add: {error}");
                            std::process::exit(1);
                        }
                        loop {
                            match receiver.recv().await {
                                Some(crate::content::ContentEvent::Added { cid, size, .. }) => {
                                    println!(
                                        "{}",
                                        serde_json::json!({
                                            "event": "added",
                                            "cid": cid,
                                            "size": size,
                                        })
                                    );
                                    break;
                                }
                                Some(crate::content::ContentEvent::Failed { message, .. }) => {
                                    eprintln!("ipfs-smoke: add failed: {message}");
                                    std::process::exit(1);
                                }
                                Some(_) => {}
                                None => break,
                            }
                        }
                    }

                    if let Ok(cid) = std::env::var("PROTO_FETCH_CID") {
                        let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                        if let Err(error) =
                            crate::content::ipfs::fetch(node.clone(), cid.clone(), None, events)
                                .await
                        {
                            eprintln!("ipfs-smoke: fetch: {error}");
                            std::process::exit(1);
                        }
                        loop {
                            match receiver.recv().await {
                                Some(crate::content::ContentEvent::Bytes {
                                    cid, bytes, ..
                                }) => {
                                    println!(
                                        "{}",
                                        serde_json::json!({
                                            "event": "fetched",
                                            "cid": cid,
                                            "bytes": bytes.len(),
                                        })
                                    );
                                    break;
                                }
                                Some(crate::content::ContentEvent::Failed { message, .. }) => {
                                    eprintln!("ipfs-smoke: fetch failed: {message}");
                                    std::process::exit(1);
                                }
                                Some(_) => {}
                                None => break,
                            }
                        }
                    }

                    if let Ok(seconds) = std::env::var("PROTO_HOLD_SECS")
                        && let Ok(seconds) = seconds.parse::<u64>()
                    {
                        tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
                    }
                }
                Err(error) => {
                    eprintln!("ipfs-smoke: {error}");
                    std::process::exit(1);
                }
            }
        });
    }
    #[cfg(not(feature = "ipfs"))]
    {
        eprintln!("ipfs-smoke: this build does not enable the ipfs feature");
        std::process::exit(1);
    }
}
