use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use space_protocol::messages::{ClientMessage, ServerMessage, SpaceMutation};
use space_protocol::projection::{pose_from_entity, session_filter};
use uuid::Uuid;

use crate::config::{ClientConfig, ClientPaths};
use crate::content::{ContentEvent, ContentService};
use crate::net::client::{ConnectOptions, NetEvent, NetHandle, unix_ms};
use crate::net::interpolation::PoseBuffer;
use crate::net::store::{ApplyError, SpaceStore};

#[derive(Debug, Clone)]
pub struct Placement {
    pub position: [f64; 3],
    pub yaw: f64,
}

/// All asynchronous results belong to the current actors. Retired actors are
/// never polled, and the next IPFS actor waits for repository shutdown.
pub struct ClientSession {
    pub config: ClientConfig,
    pub store: SpaceStore,
    paths: ClientPaths,
    net: Option<NetHandle>,
    content: Option<ContentService>,
    retired_content: Vec<ContentService>,
    retired_net: Vec<NetHandle>,
    status: &'static str,
    self_id: Option<String>,
    subscription: Option<String>,
    session_id: String,
    rtt_ms: Option<u64>,
    server_offset_ms: f64,
    tick_rate: u32,
    ipfs_ready: bool,
    ipfs_started: bool,
    addresses: Vec<String>,
    placements: HashMap<PathBuf, Placement>,
    avatar_upload: Option<PathBuf>,
    avatar_sent: bool,
    pending: HashSet<String>,
    transfers: HashMap<PathBuf, String>,
    peers: HashMap<String, PoseBuffer>,
    pose: Option<Value>,
    last_pose: Instant,
    events: VecDeque<Value>,
    state_dirty: bool,
}

impl ClientSession {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        let paths = ClientPaths::new(data_dir);
        Self {
            config: ClientConfig::load_from(&paths.config_file),
            store: SpaceStore::default(),
            paths,
            net: None,
            content: None,
            retired_content: Vec::new(),
            retired_net: Vec::new(),
            status: "offline",
            self_id: None,
            subscription: None,
            session_id: "main".into(),
            rtt_ms: None,
            server_offset_ms: 0.0,
            tick_rate: 20,
            ipfs_ready: false,
            ipfs_started: false,
            addresses: Vec::new(),
            placements: HashMap::new(),
            avatar_upload: None,
            avatar_sent: false,
            pending: HashSet::new(),
            transfers: HashMap::new(),
            peers: HashMap::new(),
            pose: None,
            last_pose: Instant::now(),
            events: VecDeque::new(),
            state_dirty: true,
        }
    }

    pub fn dispatch(&mut self, command: Value) -> Result<Value, String> {
        let result = self.dispatch_inner(&command);
        if let Err(message) = &result {
            let command_id = command
                .get("commandId")
                .or_else(|| command.pointer("/message/mutation/commandId"))
                .or_else(|| command.pointer("/message/commandId"));
            self.events
                .push_back(json!({"type":"error", "message":message,
                "commandId":command_id}));
        }
        result
    }

    fn dispatch_inner(&mut self, command: &Value) -> Result<Value, String> {
        match text(command, "op")? {
            "config" => serde_json::to_value(&self.config).map_err(|error| error.to_string()),
            "connect" => {
                let server = text(command, "server")?.to_owned();
                let name = text(command, "name")?.to_owned();
                let url = reqwest::Url::parse(&server).map_err(|error| error.to_string())?;
                if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() {
                    return Err("server must be a ws:// or wss:// URL".into());
                }
                self.shutdown();
                self.config.server = server.clone();
                self.config.name = name.clone();
                self.config.save_to(&self.paths.config_file)?;
                self.net = Some(NetHandle::spawn(Some(ConnectOptions {
                    server,
                    name,
                    session_id: "main".into(),
                })));
                self.status = "connecting";
                self.state_dirty = true;
                self.events.push_back(self.state_event());
                Ok(json!({"ok":true}))
            }
            "disconnect" => {
                self.shutdown();
                Ok(json!({"ok":true}))
            }
            "send" => {
                let message: ClientMessage = serde_json::from_value(
                    command.get("message").cloned().ok_or("missing message")?,
                )
                .map_err(|error| error.to_string())?;
                let id = command_id(&message).map(str::to_owned);
                self.send(message)?;
                Ok(json!({"ok":true,"commandId":id}))
            }
            "pose" => {
                let position: [f64; 3] = array(command, "position")?;
                let head: [f64; 4] = array(command, "head")?;
                let crouch = number(command, "crouch")?;
                let lean = number(command, "lean")?;
                self.pose = Some(json!({"space.position":position,"space.head":head,
                    "space.crouch":crouch,"space.lean":lean}));
                Ok(json!({"ok":true}))
            }
            "drop" | "avatar" => {
                self.require_online()?;
                if command["op"] == "avatar" && command.get("cid").is_some() {
                    let cid = match command.get("cid") {
                        Some(Value::Null) => None,
                        Some(Value::String(cid)) => Some(validate_cid(cid)?.to_owned()),
                        _ => return Err("cid must be a string or null".into()),
                    };
                    self.avatar_upload = None;
                    self.config.avatar_path = None;
                    self.config.avatar_cid = cid.clone();
                    self.config.save_to(&self.paths.config_file)?;
                    let id = Uuid::new_v4().to_string();
                    self.send(ClientMessage::SpaceSetAvatar {
                        command_id: id.clone(),
                        cid,
                    })?;
                    self.avatar_sent = true;
                    return Ok(json!({"ok":true,"commandId":id}));
                }
                let path = PathBuf::from(text(command, "path")?);
                if self.placements.contains_key(&path) || self.avatar_upload.as_ref() == Some(&path)
                {
                    return Err("file upload is already pending".into());
                }
                let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
                if !metadata.is_file() {
                    return Err("path must be a regular file".into());
                }
                if !self.ipfs_ready {
                    return Err("IPFS is not ready".into());
                }
                let avatar = command["op"] == "avatar"
                    || path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("vrm"));
                if avatar {
                    if metadata.len() > 100 * 1024 * 1024 {
                        return Err("avatar exceeds 100 MiB".into());
                    }
                    self.avatar_upload = Some(path.clone());
                    self.avatar_sent = true;
                } else {
                    self.placements.insert(
                        path.clone(),
                        Placement {
                            position: array(command, "position")?,
                            yaw: number(command, "yaw")?,
                        },
                    );
                }
                self.content
                    .as_ref()
                    .ok_or("content actor is not ready")?
                    .add_file(path);
                Ok(json!({"ok":true}))
            }
            "fetch" | "download" => {
                let cid = validate_cid(text(command, "cid")?)?.to_owned();
                let download = command["op"] == "download";
                let path = if download {
                    self.paths
                        .download_dir
                        .join(safe_name(text(command, "name")?))
                } else {
                    self.paths.cache_dir.join("assets").join(&cid)
                };
                if !download && path.is_file() {
                    self.events
                        .push_back(json!({"type":"asset","cid":cid,"path":path}));
                } else if !self.transfers.contains_key(&path) {
                    let content = self.content.as_ref().ok_or("content actor is not ready")?;
                    self.transfers.insert(path.clone(), cid.clone());
                    content.fetch_to(cid, path.clone());
                } else if self
                    .transfers
                    .get(&path)
                    .is_some_and(|active| active != &cid)
                {
                    return Err("another download is using this filename".into());
                }
                Ok(json!({"ok":true,"path":path}))
            }
            "sample_peers" => {
                let now = unix_ms() as f64 + self.server_offset_ms - 100.0;
                let mut peers = serde_json::Map::new();
                for (id, buffer) in &self.peers {
                    if let Some(pose) = buffer.sample(now) {
                        peers.insert(
                            id.clone(),
                            json!({"position":pose.position,"head":pose.head,
                            "crouch":pose.crouch,"lean":pose.lean}),
                        );
                    }
                }
                Ok(Value::Object(peers))
            }
            _ => Err("unknown operation".into()),
        }
    }

    fn require_online(&self) -> Result<(), String> {
        if self.status != "online" {
            return Err("not connected".into());
        }
        Ok(())
    }

    fn send(&mut self, message: ClientMessage) -> Result<(), String> {
        self.require_online()?;
        let id = command_id(&message).map(str::to_owned);
        if !self.net.as_ref().is_some_and(|net| net.send(message)) {
            return Err("network actor stopped".into());
        }
        if let Some(id) = id {
            self.pending.insert(id);
        }
        Ok(())
    }

    fn reset_world(&mut self) {
        self.store = SpaceStore::default();
        self.self_id = None;
        self.subscription = None;
        self.rtt_ms = None;
        self.pending.clear();
        self.placements.clear();
        self.avatar_upload = None;
        self.avatar_sent = false;
        self.peers.clear();
        self.pose = None;
        self.state_dirty = true;
    }

    fn retire_content(&mut self) {
        if let Some(content) = self.content.take() {
            content.shutdown();
            self.retired_content.push(content);
        }
        self.ipfs_ready = false;
        self.ipfs_started = false;
        self.transfers.clear();
    }

    pub fn shutdown(&mut self) {
        if let Some(net) = self.net.take() {
            net.shutdown();
            self.retired_net.push(net);
        }
        self.retire_content();
        self.reset_world();
        self.events.clear();
        self.status = "offline";
    }

    pub fn poll(&mut self) -> Vec<Value> {
        self.retired_net.retain(|net| !net.is_finished());
        self.retired_content
            .retain(|content| !content.is_finished());
        if self.net.is_some() && self.content.is_none() && self.retired_content.is_empty() {
            self.content = Some(ContentService::spawn(self.config.http_base()));
        }
        let network = self.net.as_ref().map(NetHandle::poll).unwrap_or_default();
        for event in network {
            match event {
                NetEvent::Connected => {
                    self.status = "connecting";
                    self.state_dirty = true;
                }
                NetEvent::Disconnected(message) => {
                    if self.status != "reconnecting" {
                        self.reset_world();
                        self.retire_content();
                    }
                    self.status = "reconnecting";
                    self.state_dirty = true;
                    // Preserve the reset even if a fresh welcome is in this poll batch.
                    self.events.push_back(self.state_event());
                    self.events
                        .push_back(json!({"type":"log","message":message}));
                }
                NetEvent::Error(message) => {
                    self.events
                        .push_back(json!({"type":"error","message":message}));
                }
                NetEvent::Message(message) => self.apply_message(message),
            }
        }
        if self.status == "online"
            && !self.ipfs_started
            && let Some(content) = &self.content
        {
            content.start_ipfs(self.paths.cache_dir.join("ipfs"));
            self.ipfs_started = true;
        }
        let content = self
            .content
            .as_ref()
            .map(ContentService::poll)
            .unwrap_or_default();
        let mut progress = HashMap::new();
        for event in content {
            match event {
                ContentEvent::Ready { peer_id } => {
                    self.ipfs_ready = true;
                    self.state_dirty = true;
                    if let Some(id) = self.self_id.clone() {
                        let _ = self.send(patch(&id, json!({"peer.ipfsPeerId":peer_id})));
                    }
                    if let Some(content) = &self.content {
                        content.connect(self.addresses.clone());
                    }
                }
                ContentEvent::Connected => self
                    .events
                    .push_back(json!({"type":"log","message":"Connected to Kubo"})),
                ContentEvent::Added {
                    cid,
                    name,
                    size: _,
                    path,
                } => self.added(cid, name, path),
                ContentEvent::Saved { cid, path } => {
                    self.transfers.remove(&path);
                    self.events
                        .push_back(json!({"type":"asset","cid":cid,"path":path}));
                }
                ContentEvent::Progress { cid, loaded, total } => {
                    progress.insert(
                        cid.clone(),
                        json!({"type":"progress","cid":cid,"loaded":loaded,"total":total}),
                    );
                }
                ContentEvent::Failed { cid, message } => {
                    if let Some(cid) = cid {
                        self.transfers.retain(|_, active| active != &cid);
                    }
                    self.events
                        .push_back(json!({"type":"error","message":message}));
                }
                ContentEvent::UploadFailed { path, message } => {
                    self.placements.remove(&path);
                    if self.avatar_upload.as_ref() == Some(&path) {
                        self.avatar_upload = None;
                    }
                    self.events
                        .push_back(json!({"type":"error","message":message}));
                }
                ContentEvent::Bytes { .. } => {}
            }
        }
        self.events.extend(progress.into_values());
        if self.status == "online" && self.ipfs_ready && !self.avatar_sent {
            self.avatar_sent = true;
            if let Some(path) = self
                .config
                .avatar_path
                .clone()
                .filter(|path| path.is_file())
            {
                self.avatar_upload = Some(path.clone());
                if let Some(content) = &self.content {
                    content.add_file(path);
                }
            } else if let Some(cid) = self.config.avatar_cid.clone() {
                let _ = self.send(ClientMessage::SpaceSetAvatar {
                    command_id: Uuid::new_v4().to_string(),
                    cid: Some(cid),
                });
            }
        }
        if self.status == "online"
            && self.last_pose.elapsed()
                >= Duration::from_secs_f64(1.0 / self.tick_rate.max(1) as f64)
        {
            self.last_pose = Instant::now();
            if let (Some(id), Some(pose)) = (self.self_id.clone(), self.pose.take()) {
                let _ = self.send(patch(&id, pose));
            }
        }
        if self.state_dirty {
            self.events.push_back(self.state_event());
            self.state_dirty = false;
        }
        self.events.drain(..self.events.len().min(256)).collect()
    }

    fn state_event(&self) -> Value {
        let mut entities: Vec<_> = self.store.entities.values().collect();
        entities.sort_by(|a, b| a.id.cmp(&b.id));
        json!({"type":"state","status":self.status,"selfId":self.self_id,
            "entities":entities,"rttMs":self.rtt_ms,"ipfsReady":self.ipfs_ready,
            "server":self.config.server,"name":self.config.name})
    }

    fn apply_message(&mut self, message: ServerMessage) {
        match message {
            ServerMessage::SpaceWelcome {
                me,
                session_id,
                subscription_id,
                version,
                seq,
                at,
                entities,
                ipfs,
                tick_rate,
                ..
            } => {
                self.reset_world();
                self.self_id = Some(me.entity_id);
                self.config.name = me.name;
                self.session_id = session_id;
                self.subscription = Some(subscription_id.clone());
                self.store.replace(subscription_id, version, seq, entities);
                self.server_offset_ms = at - unix_ms() as f64;
                self.tick_rate = tick_rate;
                self.addresses = kubo_addresses(&self.config.server, &ipfs);
                self.status = "online";
                self.record_peers(at);
            }
            ServerMessage::SpaceSnapshot {
                subscription_id,
                version,
                seq,
                at,
                entities,
            } => {
                if self.subscription.as_deref() != Some(&subscription_id) {
                    return;
                }
                self.store.replace(subscription_id, version, seq, entities);
                self.peers.clear();
                self.record_peers(at);
                self.state_dirty = true;
            }
            ServerMessage::SpaceDelta {
                subscription_id,
                version,
                seq,
                at,
                changes,
            } => {
                match self
                    .store
                    .apply_delta(&subscription_id, version, seq, changes)
                {
                    Ok(()) => {
                        self.server_offset_ms = at - unix_ms() as f64;
                        self.record_peers(at);
                        self.state_dirty = true;
                    }
                    Err(ApplyError::Gap { .. }) => {
                        if let (Some(net), Some(subscription_id)) = (&self.net, &self.subscription)
                        {
                            net.send(ClientMessage::SpaceSubscribe {
                                subscription_id: subscription_id.clone(),
                                filter: session_filter(&self.session_id),
                            });
                        }
                    }
                    Err(ApplyError::WrongSubscription) => {}
                }
            }
            ServerMessage::SpacePong { id } => {
                self.rtt_ms = Some(unix_ms().saturating_sub(id));
                self.state_dirty = true;
            }
            ServerMessage::SpaceAck { command_id, .. } => {
                self.pending.remove(&command_id);
            }
            ServerMessage::SpaceError {
                command_id,
                code,
                message,
            } => {
                if let Some(id) = &command_id {
                    self.pending.remove(id);
                }
                self.events.push_back(
                    json!({"type":"error","message":message,"commandId":command_id,"code":code}),
                );
            }
            ServerMessage::FileProgress {
                cid, loaded, total, ..
            } => self
                .events
                .push_back(json!({"type":"progress","cid":cid,"loaded":loaded,"total":total})),
            ServerMessage::FileFailed { message, .. } => self
                .events
                .push_back(json!({"type":"error","message":message})),
            ServerMessage::SpaceQueryResult { .. } => {}
        }
    }

    fn record_peers(&mut self, at: f64) {
        self.peers.retain(|id, _| {
            self.store.entities.get(id).is_some_and(|entity| {
                entity.dimensions.get("entity.kind").and_then(Value::as_str) == Some("peer")
            })
        });
        for entity in self.store.entities.values().filter(|entity| {
            entity.dimensions.get("entity.kind").and_then(Value::as_str) == Some("peer")
        }) {
            self.peers
                .entry(entity.id.clone())
                .or_default()
                .push(at, pose_from_entity(entity));
        }
    }

    fn added(&mut self, cid: String, name: String, path: PathBuf) {
        if self.avatar_upload.as_ref() == Some(&path) {
            self.avatar_upload = None;
            self.config.avatar_cid = Some(cid.clone());
            self.config.avatar_path = Some(path);
            if let Err(message) = self.config.save_to(&self.paths.config_file) {
                self.events
                    .push_back(json!({"type":"error","message":message}));
            }
            let _ = self.send(ClientMessage::SpaceSetAvatar {
                command_id: Uuid::new_v4().to_string(),
                cid: Some(cid),
            });
        } else if let Some(placement) = self.placements.remove(&path) {
            let dimensions = placement_dimensions(&path, &cid, &name, &placement);
            let _ = self.send(ClientMessage::SpaceMutate {
                mutation: SpaceMutation::Create {
                    command_id: Uuid::new_v4().to_string(),
                    entity_id: Uuid::new_v4().to_string(),
                    dimensions: dimensions.as_object().unwrap().clone(),
                },
            });
        }
    }
}

impl Drop for ClientSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn placement_dimensions(
    path: &std::path::Path,
    cid: &str,
    name: &str,
    placement: &Placement,
) -> Value {
    let name: String = name.chars().take(120).collect();
    let image = image::ImageReader::open(path)
        .ok()
        .and_then(|reader| reader.with_guessed_format().ok())
        .and_then(|reader| reader.into_dimensions().ok());
    if let Some((width, height)) = image {
        let scale = 2.5 / width.max(height).max(1) as f32;
        json!({"entity.kind":"image","space.position":placement.position,"space.yaw":placement.yaw,
            "content.cid":cid,"content.name":name,"content.width":(width as f32 * scale).max(0.1),
            "content.height":(height as f32 * scale).max(0.1)})
    } else {
        json!({"entity.kind":"file","space.position":[placement.position[0],space_protocol::FILE_FLOAT_HEIGHT,placement.position[2]],
            "space.yaw":placement.yaw,"content.cid":cid,"content.name":name})
    }
}

pub fn patch(entity_id: &str, set: Value) -> ClientMessage {
    ClientMessage::SpaceMutate {
        mutation: SpaceMutation::Patch {
            command_id: Uuid::new_v4().to_string(),
            entity_id: entity_id.into(),
            set: set.as_object().cloned(),
            unset: None,
            conditions: None,
            if_version: None,
        },
    }
}

fn command_id(message: &ClientMessage) -> Option<&str> {
    match message {
        ClientMessage::SpaceMutate { mutation } => Some(mutation.command_id()),
        ClientMessage::SpaceSetAvatar { command_id, .. }
        | ClientMessage::SpaceImportUrl { command_id, .. }
        | ClientMessage::FileRequest { command_id, .. } => Some(command_id),
        _ => None,
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string {key}"))
}

fn number(value: &Value, key: &str) -> Result<f64, String> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or_else(|| format!("missing finite number {key}"))
}

fn array<const N: usize>(value: &Value, key: &str) -> Result<[f64; N], String> {
    let values = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing array {key}"))?;
    if values.len() != N {
        return Err(format!("{key} must contain {N} numbers"));
    }
    let mut result = [0.0; N];
    for (out, value) in result.iter_mut().zip(values) {
        *out = value
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| format!("invalid {key}"))?;
    }
    Ok(result)
}

fn validate_cid(cid: &str) -> Result<&str, String> {
    if cid.is_empty() || cid.len() > 128 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("invalid CID".into());
    }
    Ok(cid)
}

pub fn safe_name(name: &str) -> String {
    let mut name: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    while name.len() > 180 {
        name.pop();
    }
    let name = name.trim_matches(['.', ' ']);
    if name.is_empty() {
        return "download.bin".into();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        format!("_{name}")
    } else {
        name.into()
    }
}

pub fn kubo_addresses(server: &str, ipfs: &space_protocol::messages::IpfsInfo) -> Vec<String> {
    let Ok(url) = reqwest::Url::parse(server) else {
        return Vec::new();
    };
    let Some(host) = url.host_str() else {
        return Vec::new();
    };
    let host = host.trim_matches(['[', ']']);
    let secure = url.scheme() == "wss";
    let prefix = match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => format!("/ip4/{ip}"),
        Ok(std::net::IpAddr::V6(ip)) => format!("/ip6/{ip}"),
        Err(_) => format!("/dns/{host}"),
    };
    let mut addresses = vec![format!("{prefix}/tcp/4001/p2p/{}", ipfs.peer_id)];
    addresses.push(format!(
        "{prefix}/tcp/{}/{}/p2p/{}",
        ipfs.ws_port,
        if secure { "tls/ws" } else { "ws" },
        ipfs.peer_id
    ));
    addresses
}

#[cfg(test)]
mod tests {
    use super::*;
    use space_protocol::messages::{
        IpfsInfo, SpaceEntity, SpaceReadScope, SpaceScope, SpaceSelf, SpaceWriteScope,
    };

    fn session() -> ClientSession {
        ClientSession::new(Some(
            std::env::temp_dir().join(format!("proto-core-{}", Uuid::new_v4())),
        ))
    }

    fn welcome(id: &str, subscription: &str) -> ServerMessage {
        ServerMessage::SpaceWelcome {
            me: SpaceSelf {peer_id: id.into(), entity_id: id.into(), name:"test".into(), color:"#ffffff".into()},
            session_id:"main".into(), template_id:space_protocol::SPACE_TEMPLATE_ID.into(),
            schema_version:space_protocol::SPACE_SCHEMA_VERSION,
            scope:SpaceScope {session_id:"main".into(),
                read:SpaceReadScope {dims:vec![], filter:Default::default()},
                write:SpaceWriteScope {dims:vec![], filter:Default::default(),can_create:true,can_delete:true,max_entities:100}},
            dimensions:Default::default(), subscription_id:subscription.into(), version:1, seq:0, at:1000.0,
            entities:vec![SpaceEntity {id:id.into(),version:1,dimensions:json!({"entity.kind":"peer","space.position":[1,2,3],"unknown.dimension":{"retained":true}}).as_object().unwrap().clone()}],
            ipfs:IpfsInfo {peer_id:"kubo".into(),ws_port:8081},ice_servers:None,tick_rate:20,
        }
    }

    #[test]
    fn facade_starts_and_disconnects_offline_and_reports_invalid_commands() {
        let mut client = session();
        assert_eq!(client.poll()[0]["status"], "offline");
        assert_eq!(
            client.dispatch(json!({"op":"config"})).unwrap()["server"],
            "ws://127.0.0.1:8080/ws"
        );
        assert!(
            client
                .dispatch(json!({"op":"connect","server":"file:///etc/passwd","name":"test"}))
                .is_err()
        );
        assert_eq!(client.poll()[0]["type"], "error");
        client.dispatch(json!({"op":"disconnect"})).unwrap();
        assert_eq!(client.poll()[0]["status"], "offline");
    }

    #[test]
    fn welcome_replaces_identity_and_clears_non_idempotent_state() {
        let mut client = session();
        client.apply_message(welcome("old", "first"));
        client.pending.insert("claim".into());
        client.placements.insert(
            PathBuf::from("old.png"),
            Placement {
                position: [0.0; 3],
                yaw: 0.0,
            },
        );
        client.pose = Some(json!({"space.position":[9,9,9]}));
        client.apply_message(welcome("new", "second"));
        assert_eq!(client.self_id.as_deref(), Some("new"));
        assert!(client.pending.is_empty());
        assert!(client.placements.is_empty());
        assert!(client.pose.is_none());
        assert!(!client.peers.contains_key("old"));
        let state = client.poll().pop().unwrap();
        assert_eq!(
            state["entities"][0]["dimensions"]["unknown.dimension"],
            json!({"retained":true})
        );
        assert_eq!(state["status"], "online");
    }

    #[test]
    fn stale_snapshots_do_not_replace_current_world() {
        let mut client = session();
        client.apply_message(welcome("new", "current"));
        client.apply_message(ServerMessage::SpaceSnapshot {
            subscription_id: "retired".into(),
            version: 99,
            seq: 99,
            at: 2000.0,
            entities: vec![],
        });
        assert!(client.store.entities.contains_key("new"));
        client.apply_message(ServerMessage::SpaceSnapshot {
            subscription_id: "current".into(),
            version: 2,
            seq: 2,
            at: 2000.0,
            entities: vec![],
        });
        assert!(client.store.entities.is_empty());
        assert!(client.peers.is_empty());
    }

    #[test]
    fn sequence_gap_resubscribes_without_applying_partial_delta() {
        let mut client = session();
        let (net, mut commands, _) = NetHandle::test_channels();
        client.net = Some(net);
        client.apply_message(welcome("me", "current"));
        client.apply_message(ServerMessage::SpaceDelta {
            subscription_id: "current".into(),
            version: 99,
            seq: 2,
            at: 2000.0,
            changes: vec![],
        });
        assert_eq!(client.store.seq, 0);
        match commands.try_recv().unwrap() {
            crate::net::client::NetCommand::Send {
                message:
                    ClientMessage::SpaceSubscribe {
                        subscription_id,
                        filter,
                    },
                ..
            } => {
                assert_eq!(subscription_id, "current");
                assert_eq!(filter, session_filter("main"));
            }
            other => panic!("expected resubscribe, got {other:?}"),
        }
    }

    #[test]
    fn reconnect_batch_exposes_reset_before_new_identity() {
        let mut client = session();
        let (net, _, events) = NetHandle::test_channels();
        client.net = Some(net);
        client.apply_message(welcome("old", "old-sub"));
        client.pending.insert("claim".into());
        events
            .send(NetEvent::Disconnected("connection lost".into()))
            .unwrap();
        events
            .send(NetEvent::Message(welcome("new", "new-sub")))
            .unwrap();
        let states: Vec<_> = client
            .poll()
            .into_iter()
            .filter(|event| event["type"] == "state")
            .collect();
        assert_eq!(states[0]["status"], "reconnecting");
        assert!(states[0]["selfId"].is_null());
        assert_eq!(states[0]["entities"], json!([]));
        assert_eq!(states.last().unwrap()["status"], "online");
        assert_eq!(states.last().unwrap()["selfId"], "new");
        assert!(client.pending.is_empty());
        assert!(!client.peers.contains_key("old"));
    }

    #[test]
    fn scope_and_claim_rejections_preserve_authoritative_store() {
        let mut client = session();
        client.apply_message(welcome("me", "sub"));
        for code in ["scope_denied", "already_held"] {
            client.pending.insert("claim".into());
            client.apply_message(ServerMessage::SpaceError {
                command_id: Some("claim".into()),
                code: code.into(),
                message: "rejected".into(),
            });
            assert!(client.pending.is_empty());
            let error = client.events.pop_back().unwrap();
            assert_eq!(error["commandId"], "claim");
            assert_eq!(error["code"], code);
            assert_eq!(client.store.entities.len(), 1);
        }
    }

    #[test]
    fn download_names_and_cids_cannot_escape_directories() {
        for name in [
            "../../file",
            "..\\file",
            "CON.txt",
            "NUL",
            "COM1.bin",
            "LPT9",
            ".",
            "",
        ] {
            let safe = safe_name(name);
            assert!(!safe.is_empty());
            assert!(!safe.contains(['/', '\\']));
            assert_eq!(std::path::Path::new(&safe).components().count(), 1);
        }
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert!(safe_name(&"\u{65e5}".repeat(120)).len() <= 180);
        assert!(validate_cid("../../secret").is_err());
        assert!(validate_cid("").is_err());
        assert!(validate_cid("bafyvalidcontent").is_ok());
    }

    #[test]
    fn failed_fetch_can_be_retried_when_actor_becomes_available() {
        let mut client = session();
        assert!(
            client
                .dispatch(json!({"op":"fetch","cid":"bafytest"}))
                .is_err()
        );
        assert!(client.transfers.is_empty());
    }

    #[test]
    fn server_change_updates_http_and_kubo_hosts() {
        let mut client = session();
        client.config.server = "wss://new.example:9443/ws".into();
        client.apply_message(welcome("me", "sub"));
        assert_eq!(client.config.http_base(), "https://new.example:9443");
        assert!(
            client
                .addresses
                .iter()
                .all(|address| address.contains("new.example"))
        );
        assert!(
            client
                .addresses
                .iter()
                .any(|address| address.contains("/tls/ws/"))
        );
    }
}
