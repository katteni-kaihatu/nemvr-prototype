use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

use bevy::prelude::Resource;
use futures_util::StreamExt;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

#[derive(Debug, Clone)]
pub enum ContentCommand {
    StartIpfs {
        repo: PathBuf,
    },
    Connect {
        addresses: Vec<String>,
    },
    AddFile {
        path: PathBuf,
    },
    Fetch {
        cid: String,
        save_to: Option<PathBuf>,
    },
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum ContentEvent {
    Ready {
        peer_id: String,
    },
    Connected,
    Added {
        cid: String,
        name: String,
        size: u64,
        path: PathBuf,
    },
    Progress {
        cid: Option<String>,
        loaded: u64,
        total: Option<u64>,
    },
    Bytes {
        cid: String,
        bytes: Vec<u8>,
    },
    Saved {
        cid: String,
        path: PathBuf,
    },
    Failed {
        cid: Option<String>,
        message: String,
    },
}

#[derive(Resource)]
pub struct ContentService {
    pub commands: UnboundedSender<ContentCommand>,
    events: Mutex<UnboundedReceiver<ContentEvent>>,
}

impl ContentService {
    pub fn spawn(http_base: String) -> Self {
        let (command_tx, command_rx) = unbounded_channel();
        let (event_tx, event_rx) = unbounded_channel();
        let base = http_base.clone();

        thread::Builder::new()
            .name("proto-client-content".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("content runtime");
                runtime.block_on(run_actor(base, command_rx, event_tx));
            })
            .expect("spawn content thread");

        Self {
            commands: command_tx,
            events: Mutex::new(event_rx),
        }
    }

    pub fn poll(&self) -> Vec<ContentEvent> {
        let mut events = Vec::new();
        let mut receiver = self.events.lock().expect("content events lock");
        while let Ok(event) = receiver.try_recv() {
            events.push(event);
        }
        events
    }

    pub fn fetch(&self, cid: impl Into<String>) {
        self.commands
            .send(ContentCommand::Fetch {
                cid: cid.into(),
                save_to: None,
            })
            .ok();
    }

    pub fn fetch_to(&self, cid: impl Into<String>, path: PathBuf) {
        self.commands
            .send(ContentCommand::Fetch {
                cid: cid.into(),
                save_to: Some(path),
            })
            .ok();
    }

    pub fn add_file(&self, path: PathBuf) {
        self.commands.send(ContentCommand::AddFile { path }).ok();
    }

    pub fn start_ipfs(&self, repo: PathBuf) {
        self.commands.send(ContentCommand::StartIpfs { repo }).ok();
    }

    pub fn connect(&self, addresses: Vec<String>) {
        self.commands
            .send(ContentCommand::Connect { addresses })
            .ok();
    }
}

async fn run_actor(
    http_base: String,
    mut commands: UnboundedReceiver<ContentCommand>,
    events: UnboundedSender<ContentEvent>,
) {
    #[cfg(feature = "ipfs")]
    let mut ipfs: Option<rust_ipfs::Ipfs> = None;

    while let Some(command) = commands.recv().await {
        match command {
            ContentCommand::StartIpfs { repo } => {
                #[cfg(feature = "ipfs")]
                {
                    match crate::content::ipfs::start(repo).await {
                        Ok((node, peer_id)) => {
                            ipfs = Some(node);
                            let _ = events.send(ContentEvent::Ready { peer_id });
                        }
                        Err(error) => {
                            let _ = events.send(ContentEvent::Failed {
                                cid: None,
                                message: format!("IPFS を開始できません: {error}"),
                            });
                        }
                    }
                }
                #[cfg(not(feature = "ipfs"))]
                {
                    let _ = repo;
                    let _ = events.send(ContentEvent::Failed {
                        cid: None,
                        message: "このビルドでは IPFS が無効です".into(),
                    });
                }
            }
            ContentCommand::Connect { addresses } => {
                #[cfg(feature = "ipfs")]
                if let Some(node) = ipfs.clone() {
                    let events = events.clone();
                    // Kubo の再起動や一時的な切断に備えて、10 秒間隔で再試行する。
                    tokio::spawn(async move {
                        let mut last_error = String::new();
                        for attempt in 0..30 {
                            let mut connected = false;
                            for address in &addresses {
                                let address_text = address.clone();
                                let Ok(parsed) = address.parse::<rust_ipfs::Multiaddr>() else {
                                    last_error = format!("{address_text}: invalid multiaddr");
                                    continue;
                                };
                                match node.connect(parsed).await {
                                    Ok(_) => {
                                        connected = true;
                                        break;
                                    }
                                    Err(error) => {
                                        last_error = format!("{address_text}: {error}");
                                    }
                                }
                            }
                            if connected {
                                let _ = events.send(ContentEvent::Connected);
                                return;
                            }
                            if attempt == 0 {
                                let _ = events.send(ContentEvent::Failed {
                                    cid: None,
                                    message: format!(
                                        "Kubo に接続できません。再試行します: {last_error}"
                                    ),
                                });
                            }
                            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        }
                        let _ = events.send(ContentEvent::Failed {
                            cid: None,
                            message: format!("Kubo に接続できません: {last_error}"),
                        });
                    });
                }
                #[cfg(not(feature = "ipfs"))]
                let _ = addresses;
            }
            ContentCommand::AddFile { path } => {
                #[cfg(feature = "ipfs")]
                if let Some(node) = ipfs.clone() {
                    let events = events.clone();
                    tokio::spawn(async move {
                        if let Err(error) =
                            crate::content::ipfs::add_file(node, path, events.clone()).await
                        {
                            let _ = events.send(ContentEvent::Failed {
                                cid: None,
                                message: format!("ファイルを追加できません: {error}"),
                            });
                        }
                    });
                } else {
                    let _ = events.send(ContentEvent::Failed {
                        cid: None,
                        message: "IPFS の準備ができていません".into(),
                    });
                }
                #[cfg(not(feature = "ipfs"))]
                {
                    let _ = path;
                    let _ = events.send(ContentEvent::Failed {
                        cid: None,
                        message: "このビルドでは IPFS が無効です".into(),
                    });
                }
            }
            ContentCommand::Fetch { cid, save_to } => {
                #[cfg(feature = "ipfs")]
                if let Some(node) = ipfs.clone() {
                    let events = events.clone();
                    let http_base = http_base.clone();
                    tokio::spawn(async move {
                        if let Err(error) = crate::content::ipfs::fetch(
                            node,
                            cid.clone(),
                            save_to.clone(),
                            events.clone(),
                        )
                        .await
                        {
                            let _ = events.send(ContentEvent::Progress {
                                cid: Some(cid.clone()),
                                loaded: 0,
                                total: None,
                            });
                            if let Err(http_error) =
                                fetch_http(&http_base, &cid, save_to, events.clone()).await
                            {
                                let _ = events.send(ContentEvent::Failed {
                                    cid: Some(cid),
                                    message: format!("{error} / HTTP: {http_error}"),
                                });
                            }
                        }
                    });
                } else {
                    let events = events.clone();
                    let http_base = http_base.clone();
                    tokio::spawn(async move {
                        if let Err(error) =
                            fetch_http(&http_base, &cid, save_to, events.clone()).await
                        {
                            let _ = events.send(ContentEvent::Failed {
                                cid: Some(cid),
                                message: error,
                            });
                        }
                    });
                }
                #[cfg(not(feature = "ipfs"))]
                {
                    let events = events.clone();
                    let http_base = http_base.clone();
                    tokio::spawn(async move {
                        if let Err(error) =
                            fetch_http(&http_base, &cid, save_to, events.clone()).await
                        {
                            let _ = events.send(ContentEvent::Failed {
                                cid: Some(cid),
                                message: error,
                            });
                        }
                    });
                }
            }
        }
    }
}

async fn fetch_http(
    http_base: &str,
    cid: &str,
    save_to: Option<PathBuf>,
    events: UnboundedSender<ContentEvent>,
) -> Result<(), String> {
    let url = format!("{}/media/{}", http_base.trim_end_matches('/'), cid);
    let response = reqwest::get(&url)
        .await
        .map_err(|error| format!("取得できません: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("取得できません: HTTP {}", response.status()));
    }
    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = if let Some(path) = &save_to {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| error.to_string())?;
        }
        Some(
            tokio::fs::File::create(path)
                .await
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let mut buffer = Vec::new();
    let mut loaded = 0u64;

    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("受信中に失敗: {error}"))?;
        loaded += chunk.len() as u64;
        if let Some(file) = &mut file {
            file.write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
        } else {
            buffer.extend_from_slice(&chunk);
        }
        let _ = events.send(ContentEvent::Progress {
            cid: Some(cid.to_owned()),
            loaded,
            total,
        });
    }

    if let Some(path) = save_to {
        let _ = events.send(ContentEvent::Saved {
            cid: cid.to_owned(),
            path,
        });
    } else {
        let _ = events.send(ContentEvent::Bytes {
            cid: cid.to_owned(),
            bytes: buffer,
        });
    }
    Ok(())
}

#[cfg(feature = "ipfs")]
pub mod ipfs {
    use std::path::PathBuf;

    use futures_util::StreamExt;
    use rust_ipfs::Ipfs;
    use rust_ipfs::builder::DefaultIpfsBuilder as IpfsBuilder;
    use rust_ipfs::unixfs::UnixfsStatus;
    use tokio::sync::mpsc::UnboundedSender;

    use super::ContentEvent;

    pub async fn start(repo: PathBuf) -> Result<(Ipfs, String), String> {
        tokio::fs::create_dir_all(&repo)
            .await
            .map_err(|error| error.to_string())?;
        let node = IpfsBuilder::new()
            .with_default()
            .with_bitswap()
            .enable_tcp()
            .enable_quic()
            .enable_dns()
            .enable_websocket()
            .enable_secure_websocket()
            .set_path(repo)
            .start()
            .await
            .map_err(|error| error.to_string())?;
        let peer_id = node
            .identity(None)
            .await
            .map_err(|error| error.to_string())?
            .peer_id
            .to_string();
        Ok((node, peer_id))
    }

    pub async fn add_file(
        node: Ipfs,
        path: PathBuf,
        events: UnboundedSender<ContentEvent>,
    ) -> Result<(), String> {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let size = tokio::fs::metadata(&path)
            .await
            .map_err(|error| error.to_string())?
            .len();

        let mut stream = node.add_unixfs(path.clone());
        while let Some(status) = stream.next().await {
            match status {
                UnixfsStatus::ProgressStatus {
                    written,
                    total_size,
                } => {
                    let _ = events.send(ContentEvent::Progress {
                        cid: None,
                        loaded: written as u64,
                        total: total_size.map(|size| size as u64).or(Some(size)),
                    });
                }
                UnixfsStatus::CompletedStatus {
                    path: ipfs_path,
                    written,
                    ..
                } => {
                    let cid = ipfs_path.root().to_string();
                    let cid = cid.strip_prefix("/ipfs/").unwrap_or(&cid).to_owned();
                    let _ = events.send(ContentEvent::Added {
                        cid,
                        name: name.clone(),
                        size: written as u64,
                        path: path.clone(),
                    });
                }
                UnixfsStatus::FailedStatus { error, .. } => {
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    }

    pub async fn fetch(
        node: Ipfs,
        cid: String,
        save_to: Option<PathBuf>,
        events: UnboundedSender<ContentEvent>,
    ) -> Result<(), String> {
        let path = cid
            .parse::<rust_ipfs::IpfsPath>()
            .map_err(|error| error.to_string())?;
        let mut stream = node.cat_unixfs(path);
        let mut buffer = Vec::new();
        let mut loaded = 0u64;
        let mut file = if let Some(path) = &save_to {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Some(
                tokio::fs::File::create(path)
                    .await
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };

        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            loaded += chunk.len() as u64;
            if let Some(file) = &mut file {
                file.write_all(&chunk)
                    .await
                    .map_err(|error| error.to_string())?;
            } else {
                buffer.extend_from_slice(&chunk);
            }
            let _ = events.send(ContentEvent::Progress {
                cid: Some(cid.clone()),
                loaded,
                total: None,
            });
        }

        if let Some(path) = save_to {
            let _ = events.send(ContentEvent::Saved { cid, path });
        } else {
            let _ = events.send(ContentEvent::Bytes { cid, bytes: buffer });
        }
        Ok(())
    }
}
