use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

use futures_util::StreamExt;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::watch;

#[derive(Debug, Clone)]
pub enum ContentCommand {
    Shutdown,
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
    UploadFailed {
        path: PathBuf,
        message: String,
    },
}

pub struct ContentService {
    pub commands: UnboundedSender<ContentCommand>,
    events: Mutex<UnboundedReceiver<ContentEvent>>,
    shutdown: watch::Sender<bool>,
    worker: thread::JoinHandle<()>,
}

impl ContentService {
    pub fn spawn(http_base: String) -> Self {
        let (command_tx, command_rx) = unbounded_channel();
        let (event_tx, event_rx) = unbounded_channel();
        let (shutdown, shutdown_rx) = watch::channel(false);
        let base = http_base.clone();

        let worker = thread::Builder::new()
            .name("proto-client-content".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("content runtime");
                runtime.block_on(run_actor(base, command_rx, event_tx, shutdown_rx));
            })
            .expect("spawn content thread");

        Self {
            commands: command_tx,
            events: Mutex::new(event_rx),
            shutdown,
            worker,
        }
    }

    pub fn poll(&self) -> Vec<ContentEvent> {
        let mut events = Vec::new();
        let mut receiver = self.events.lock().expect("content events lock");
        for _ in 0..256 {
            match receiver.try_recv() {
                Ok(event) => events.push(event),
                Err(_) => break,
            }
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

    pub fn shutdown(&self) {
        self.shutdown.send(true).ok();
    }

    pub fn is_finished(&self) -> bool {
        self.worker.is_finished()
    }
}

impl Drop for ContentService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn run_actor(
    http_base: String,
    mut commands: UnboundedReceiver<ContentCommand>,
    events: UnboundedSender<ContentEvent>,
    mut shutdown: watch::Receiver<bool>,
) {
    #[cfg(feature = "ipfs")]
    let mut ipfs: Option<rust_ipfs::Ipfs> = None;

    let mut tasks = tokio::task::JoinSet::new();
    let mut partials = std::collections::HashMap::new();
    loop {
        let command = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            command = commands.recv() => match command {
                Some(command) => command,
                None => break,
            },
            Some(result) = tasks.join_next_with_id(), if !tasks.is_empty() => {
                let id = match result {Ok((id, ())) => id, Err(error) => error.id()};
                if let Some(path) = partials.remove(&id) {tokio::fs::remove_file(path).await.ok();}
                continue;
            },
        };
        match command {
            ContentCommand::Shutdown => break,
            ContentCommand::StartIpfs { repo } => {
                #[cfg(feature = "ipfs")]
                {
                    if ipfs.is_some() {
                        continue;
                    }
                    // Complete startup so cancellation cannot orphan a daemon that
                    // acquired the repository lock before returning its handle.
                    let result = crate::content::ipfs::start(repo).await;
                    match result {
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
                    if *shutdown.borrow() {
                        break;
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
                    tasks.spawn(async move {
                        let mut last_error = String::new();
                        for attempt in 0..30 {
                            let mut connected = false;
                            let mut errors = Vec::new();
                            for address in &addresses {
                                let address_text = address.clone();
                                let Ok(parsed) = address.parse::<rust_ipfs::Multiaddr>() else {
                                    errors.push(format!("{address_text}: invalid multiaddr"));
                                    continue;
                                };
                                match node.connect(parsed).await {
                                    Ok(_) => {
                                        connected = true;
                                        break;
                                    }
                                    Err(error) => {
                                        errors.push(format!("{address_text}: {error}"));
                                    }
                                }
                            }
                            last_error = errors.join("; ");
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
                    tasks.spawn(async move {
                        let source = path.clone();
                        if let Err(error) =
                            crate::content::ipfs::add_file(node, path, events.clone()).await
                        {
                            let _ = events.send(ContentEvent::UploadFailed {
                                path: source,
                                message: format!("ファイルを追加できません: {error}"),
                            });
                        }
                    });
                } else {
                    let _ = events.send(ContentEvent::UploadFailed {
                        path,
                        message: "IPFS の準備ができていません".into(),
                    });
                }
                #[cfg(not(feature = "ipfs"))]
                {
                    let _ = events.send(ContentEvent::UploadFailed {
                        path,
                        message: "このビルドでは IPFS が無効です".into(),
                    });
                }
            }
            ContentCommand::Fetch { cid, save_to } => {
                let partial = save_to.as_ref().map(|path| part_path(path));
                #[cfg(feature = "ipfs")]
                let task = if let Some(node) = ipfs.clone() {
                    let events = events.clone();
                    let http_base = http_base.clone();
                    tasks.spawn(async move {
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
                    })
                } else {
                    let events = events.clone();
                    let http_base = http_base.clone();
                    tasks.spawn(async move {
                        if let Err(error) =
                            fetch_http(&http_base, &cid, save_to, events.clone()).await
                        {
                            let _ = events.send(ContentEvent::Failed {
                                cid: Some(cid),
                                message: error,
                            });
                        }
                    })
                };
                #[cfg(not(feature = "ipfs"))]
                let task = {
                    let events = events.clone();
                    let http_base = http_base.clone();
                    tasks.spawn(async move {
                        if let Err(error) =
                            fetch_http(&http_base, &cid, save_to, events.clone()).await
                        {
                            let _ = events.send(ContentEvent::Failed {
                                cid: Some(cid),
                                message: error,
                            });
                        }
                    })
                };
                if let Some(path) = partial {
                    partials.insert(task.id(), path);
                }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    for path in partials.into_values() {
        tokio::fs::remove_file(path).await.ok();
    }
    #[cfg(feature = "ipfs")]
    if let Some(node) = ipfs {
        node.exit_daemon().await;
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
    let part_path = save_to.as_ref().map(|path| part_path(path));
    let mut file = if let Some(path) = &part_path {
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
    let mut last_progress = std::time::Instant::now();

    use tokio::io::AsyncWriteExt;
    let result = async {
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
            if last_progress.elapsed() >= std::time::Duration::from_millis(100) {
                last_progress = std::time::Instant::now();
                let _ = events.send(ContentEvent::Progress {
                    cid: Some(cid.to_owned()),
                    loaded,
                    total,
                });
            }
        }
        if let Some(file) = &mut file {
            file.flush().await.map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    .await;

    drop(file);
    if let Err(error) = result {
        if let Some(part) = &part_path {
            tokio::fs::remove_file(part).await.ok();
        }
        return Err(error);
    }

    if let Some(path) = save_to {
        if let Some(part) = part_path {
            tokio::fs::rename(&part, &path)
                .await
                .map_err(|error| error.to_string())?;
        }
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
    let _ = events.send(ContentEvent::Progress {
        cid: Some(cid.to_owned()),
        loaded,
        total,
    });
    Ok(())
}

fn part_path(path: &std::path::Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    path.with_file_name(name)
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
        let peer_id = match node.identity(None).await {
            Ok(identity) => identity.peer_id.to_string(),
            Err(error) => {
                node.exit_daemon().await;
                return Err(error.to_string());
            }
        };
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
        let mut last_progress = std::time::Instant::now();
        while let Some(status) = stream.next().await {
            match status {
                UnixfsStatus::ProgressStatus {
                    written,
                    total_size,
                } => {
                    if last_progress.elapsed() >= std::time::Duration::from_millis(100) {
                        last_progress = std::time::Instant::now();
                        let _ = events.send(ContentEvent::Progress {
                            cid: None,
                            loaded: written as u64,
                            total: total_size.map(|size| size as u64).or(Some(size)),
                        });
                    }
                }
                UnixfsStatus::CompletedStatus {
                    path: ipfs_path,
                    written,
                    ..
                } => {
                    let cid = ipfs_path.root().to_string();
                    let cid = cid.strip_prefix("/ipfs/").unwrap_or(&cid).to_owned();
                    let _ = events.send(ContentEvent::Progress {
                        cid: Some(cid.clone()),
                        loaded: written as u64,
                        total: Some(size),
                    });
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
        let mut last_progress = std::time::Instant::now();
        let part_path = save_to.as_ref().map(|path| super::part_path(path));
        let mut file = if let Some(path) = &part_path {
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
        let result = async {
            loop {
                let next = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
                    .await
                    .map_err(|_| "IPFS の取得がタイムアウトしました".to_string())?;
                let Some(chunk) = next else {
                    break;
                };
                let chunk = chunk.map_err(|error| error.to_string())?;
                loaded += chunk.len() as u64;
                if let Some(file) = &mut file {
                    file.write_all(&chunk)
                        .await
                        .map_err(|error| error.to_string())?;
                } else {
                    buffer.extend_from_slice(&chunk);
                }
                if last_progress.elapsed() >= std::time::Duration::from_millis(100) {
                    last_progress = std::time::Instant::now();
                    let _ = events.send(ContentEvent::Progress {
                        cid: Some(cid.clone()),
                        loaded,
                        total: None,
                    });
                }
            }
            if let Some(file) = &mut file {
                file.flush().await.map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        .await;

        drop(file);
        if let Err(error) = result {
            if let Some(part) = &part_path {
                tokio::fs::remove_file(part).await.ok();
            }
            return Err(error);
        }

        let _ = events.send(ContentEvent::Progress {
            cid: Some(cid.clone()),
            loaded,
            total: Some(loaded),
        });
        if let Some(path) = save_to {
            if let Some(part) = part_path {
                tokio::fs::rename(&part, &path)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let _ = events.send(ContentEvent::Saved { cid, path });
        } else {
            let _ = events.send(ContentEvent::Bytes { cid, bytes: buffer });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn http_fallback_streams_to_part_then_emits_local_path() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            assert!(
                std::str::from_utf8(&request[..count])
                    .unwrap()
                    .starts_with("GET /media/bafytest ")
            );
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello world").await.unwrap();
        });
        let root = std::env::temp_dir().join(format!("proto-content-{}", uuid::Uuid::new_v4()));
        let destination = root.join("saved.bin");
        let content = ContentService::spawn(format!("http://{address}"));
        content.fetch_to("bafytest", destination.clone());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                for event in content.poll() {
                    match event {
                        ContentEvent::Saved { cid, path } => {
                            assert_eq!(cid, "bafytest");
                            assert_eq!(path, destination);
                            return;
                        }
                        ContentEvent::Failed { message, .. } => panic!("{message}"),
                        _ => {}
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello world");
        assert!(!part_path(&destination).exists());
        content.shutdown();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !content.is_finished() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        server.await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_cancels_download_and_removes_partial_file() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\npartial")
                .await
                .unwrap();
            stream
        });
        let root = std::env::temp_dir().join(format!("proto-cancel-{}", uuid::Uuid::new_v4()));
        let destination = root.join("pending.bin");
        let content = ContentService::spawn(format!("http://{address}"));
        content.fetch_to("bafytest", destination.clone());
        let _connection = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !part_path(&destination).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        content.shutdown();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !content.is_finished() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!destination.exists());
        assert!(!part_path(&destination).exists());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(feature = "ipfs")]
    #[tokio::test]
    async fn ipfs_shutdown_releases_repository_before_reopen() {
        let repo = std::env::temp_dir().join(format!("proto-ipfs-{}", uuid::Uuid::new_v4()));
        for attempt in 0..2 {
            let content = ContentService::spawn("http://127.0.0.1:1".into());
            content.start_ipfs(repo.clone());
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    if attempt == 0 && repo.exists() {
                        return;
                    }
                    for event in content.poll() {
                        match event {
                            ContentEvent::Ready { .. } => return,
                            ContentEvent::Failed { message, .. } => panic!("{message}"),
                            _ => {}
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            content.shutdown();
            tokio::time::timeout(Duration::from_secs(15), async {
                while !content.is_finished() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        tokio::fs::remove_dir_all(repo).await.unwrap();
    }
}
