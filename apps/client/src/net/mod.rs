pub mod client;
pub mod interpolation;
pub mod store;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;

use bevy::prelude::*;
use serde_json::json;
use space_protocol::messages::{ClientMessage, ServerMessage, SpaceMutation};
use space_protocol::projection::{ProjectedWorld, project_entities};
use uuid::Uuid;

use crate::config::ClientConfig;
use crate::content::{ContentEvent, ContentService};
use crate::net::client::{ConnectOptions, NetEvent, NetHandle, unix_ms};
use crate::net::store::{ApplyError, SpaceStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetStatus {
    Idle,
    Connecting,
    Online,
    Reconnecting,
}

#[derive(Resource)]
pub struct NetState {
    pub status: NetStatus,
    pub name: String,
    pub server: String,
    pub self_entity: Option<String>,
    pub self_peer: Option<String>,
    pub session_id: String,
    pub subscription_id: Option<String>,
    pub ipfs: Option<space_protocol::messages::IpfsInfo>,
    pub ipfs_peer_id: Option<String>,
    pub kubo_addresses: Vec<String>,
    pub ipfs_started: bool,
    pub kubo_connected: bool,
    pub avatar_upload: Option<PathBuf>,
    pub avatar_sent: bool,
    pub tick_rate: u32,
    pub server_offset_ms: f64,
    pub rtt_ms: Option<u64>,
    pub logs: VecDeque<String>,
    pub notice: Option<String>,
    pub progress: HashMap<String, (u64, Option<u64>)>,
    pub pending: HashMap<String, String>,
    pub projected: ProjectedWorld,
    pub welcome_received: bool,
    pub last_rejected_command: Option<String>,
}

impl Default for NetState {
    fn default() -> Self {
        Self {
            status: NetStatus::Idle,
            name: String::new(),
            server: String::new(),
            self_entity: None,
            self_peer: None,
            session_id: "main".into(),
            subscription_id: None,
            ipfs: None,
            ipfs_peer_id: None,
            kubo_addresses: Vec::new(),
            ipfs_started: false,
            kubo_connected: false,
            avatar_upload: None,
            avatar_sent: false,
            tick_rate: 20,
            server_offset_ms: 0.0,
            rtt_ms: None,
            logs: VecDeque::new(),
            notice: None,
            progress: HashMap::new(),
            pending: HashMap::new(),
            projected: ProjectedWorld::default(),
            welcome_received: false,
            last_rejected_command: None,
        }
    }
}

impl NetState {
    pub fn log(&mut self, message: impl Into<String>) {
        self.logs.push_back(message.into());
        while self.logs.len() > 8 {
            self.logs.pop_front();
        }
    }

    pub fn server_now(&self) -> f64 {
        unix_ms() as f64 + self.server_offset_ms
    }
}

#[derive(Resource, Default)]
pub struct ContentCache {
    pub bytes: HashMap<String, Vec<u8>>,
    pub requested: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct Placement {
    pub position: [f64; 3],
    pub yaw: f64,
}

#[derive(Resource, Default)]
pub struct PendingPlacements {
    pub by_path: HashMap<PathBuf, Placement>,
}

pub struct NetPlugin;

impl Plugin for NetPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            Update,
            (poll_network, poll_content, send_pose, update_projection).chain(),
        );
    }
}

pub fn connect_options(server: &str, name: &str) -> ConnectOptions {
    ConnectOptions {
        server: server.to_owned(),
        name: name.to_owned(),
        session_id: "main".into(),
    }
}

fn poll_network(
    net: Option<Res<NetHandle>>,
    mut state: ResMut<NetState>,
    mut store: ResMut<SpaceStore>,
    content: Option<Res<ContentService>>,
    mut next_state: ResMut<NextState<crate::AppState>>,
    mut pending_placements: ResMut<PendingPlacements>,
) {
    let Some(net) = net else {
        return;
    };

    for event in net.poll() {
        match event {
            NetEvent::Connected => {
                state.status = NetStatus::Connecting;
                state.log("WebSocket に接続しました");
                next_state.set(crate::AppState::Connecting);
            }
            NetEvent::Message(message) => match message {
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
                    state.self_entity = Some(me.entity_id.clone());
                    state.self_peer = Some(me.peer_id);
                    state.name = me.name;
                    state.session_id = session_id.clone();
                    state.subscription_id = Some(subscription_id.clone());
                    state.ipfs = Some(ipfs.clone());
                    state.tick_rate = tick_rate;
                    state.server_offset_ms = at - unix_ms() as f64;
                    state.status = NetStatus::Online;
                    state.welcome_received = true;
                    state.avatar_sent = false;
                    state.kubo_addresses = kubo_addresses(&state.server, &ipfs);
                    store.replace(subscription_id, version, seq, entities);
                    state.projected = project_entities(store.entities.values());
                    state.log("ワールドに入りました");
                    next_state.set(crate::AppState::InWorld);

                    if !state.ipfs_started
                        && let Some(content) = &content
                        && let Some(dirs) = crate::config::project_dirs()
                    {
                        state.ipfs_started = true;
                        content.start_ipfs(dirs.cache_dir().join("ipfs"));
                    }
                }
                ServerMessage::SpaceSnapshot {
                    subscription_id,
                    version,
                    seq,
                    entities,
                    ..
                } => {
                    store.replace(subscription_id, version, seq, entities);
                    state.projected = project_entities(store.entities.values());
                }
                ServerMessage::SpaceDelta {
                    subscription_id,
                    version,
                    seq,
                    changes,
                    at,
                    ..
                } => {
                    state.server_offset_ms = at - unix_ms() as f64;
                    match store.apply_delta(&subscription_id, version, seq, changes) {
                        Ok(()) => {
                            state.projected = project_entities(store.entities.values());
                        }
                        Err(ApplyError::Gap { expected, received }) => {
                            state.log(format!(
                                "更新を取りこぼしました ({received}、期待 {expected})。再購読します"
                            ));
                            if let Some(subscription) = state.subscription_id.clone() {
                                let message = ClientMessage::SpaceSubscribe {
                                    subscription_id: subscription,
                                    filter: space_protocol::projection::session_filter(
                                        &state.session_id,
                                    ),
                                };
                                net.send(message);
                            }
                        }
                        Err(ApplyError::WrongSubscription) => {}
                    }
                }
                ServerMessage::SpacePong { id } => {
                    let now = unix_ms();
                    if now >= id {
                        state.rtt_ms = Some(now - id);
                    }
                }
                ServerMessage::SpaceAck { command_id, .. } => {
                    state.pending.remove(&command_id);
                }
                ServerMessage::SpaceError {
                    command_id,
                    code,
                    message,
                } => {
                    if let Some(command_id) = &command_id {
                        state.pending.remove(command_id);
                        state.last_rejected_command = Some(command_id.clone());
                    }
                    state.notice = Some(format!("{message} ({code})"));
                    state.log(format!("サーバーエラー: {message} ({code})"));
                }
                ServerMessage::FileProgress {
                    entity_id,
                    cid,
                    loaded,
                    total,
                    ..
                } => {
                    let key = entity_id.or(cid).unwrap_or_default();
                    state.progress.insert(key, (loaded, total));
                }
                ServerMessage::FileFailed {
                    entity_id,
                    cid,
                    message,
                    ..
                } => {
                    let key = entity_id.or(cid).unwrap_or_default();
                    state.notice = Some(message.clone());
                    state.log(format!("ファイル: {message}"));
                    state.progress.remove(&key);
                }
                ServerMessage::SpaceQueryResult { .. } => {}
            },
            NetEvent::Disconnected(reason) => {
                state.status = NetStatus::Reconnecting;
                state.welcome_received = false;
                state.log(reason);
            }
            NetEvent::Error(error) => {
                state.status = NetStatus::Reconnecting;
                state.log(error);
            }
        }
    }

    // 古い配置予約を掃除する (接続が切れた場合など)
    if state.status == NetStatus::Reconnecting {
        pending_placements.by_path.clear();
    }
}

fn poll_content(
    content: Option<Res<ContentService>>,
    net: Option<Res<NetHandle>>,
    mut state: ResMut<NetState>,
    mut config: ResMut<ClientConfig>,
    mut cache: ResMut<ContentCache>,
    mut pending: ResMut<PendingPlacements>,
    mut store: ResMut<SpaceStore>,
) {
    let (Some(content), Some(net)) = (content, net) else {
        return;
    };

    for event in content.poll() {
        match event {
            ContentEvent::Ready { peer_id } => {
                state.ipfs_peer_id = Some(peer_id.clone());
                state.log(format!("IPFS を開始しました: {peer_id}"));
                if let Some(entity_id) = state.self_entity.clone() {
                    send_patch(
                        net.as_ref(),
                        &entity_id,
                        json!({ "peer.ipfsPeerId": peer_id }),
                    );
                }
                if !state.kubo_addresses.is_empty() {
                    content.connect(state.kubo_addresses.clone());
                }
            }
            ContentEvent::Connected => {
                state.kubo_connected = true;
                state.notice = None;
                state.log("Kubo に接続しました");
            }
            ContentEvent::Added {
                cid,
                name,
                size,
                path,
            } => {
                bevy::log::info!("content added: {name} ({cid})");
                if state.avatar_upload.as_deref() == Some(path.as_path()) {
                    if let Some(dirs) = crate::config::project_dirs() {
                        let dir = dirs.cache_dir().join("assets").join("vrm");
                        std::fs::create_dir_all(&dir).ok();
                        std::fs::copy(&path, dir.join(format!("{cid}.vrm"))).ok();
                    }
                    config.avatar_path = Some(path.clone());
                    config.save();
                    state.avatar_sent = true;
                    state.avatar_upload = None;
                    state.notice = Some("アバターをサーバーへ送信中".into());
                    state.log("アバターをアップロードしました");
                    continue;
                }
                let name: String = name.chars().take(120).collect();
                let placement = pending.by_path.remove(&path);
                let Some(placement) = placement else {
                    state.log(format!("{name}: 配置先がありません"));
                    continue;
                };
                let entity_id = Uuid::new_v4().to_string();
                let is_image = image::ImageReader::open(&path)
                    .ok()
                    .and_then(|reader| reader.with_guessed_format().ok())
                    .and_then(|reader| reader.into_dimensions().ok());

                let dimensions = if let Some((width, height)) = is_image {
                    let long = width.max(height).max(1) as f32;
                    let scale = 2.5 / long;
                    json!({
                        "entity.kind": "image",
                        "space.position": placement.position,
                        "space.yaw": placement.yaw,
                        "content.cid": cid,
                        "content.name": name,
                        "content.width": (width as f32 * scale).max(0.1),
                        "content.height": (height as f32 * scale).max(0.1),
                    })
                } else {
                    json!({
                        "entity.kind": "file",
                        "space.position": [placement.position[0], space_protocol::FILE_FLOAT_HEIGHT, placement.position[2]],
                        "space.yaw": placement.yaw,
                        "content.cid": cid,
                        "content.name": name,
                    })
                };

                if let Some(dimensions) = dimensions.as_object() {
                    let command = SpaceMutation::Create {
                        command_id: Uuid::new_v4().to_string(),
                        entity_id,
                        dimensions: dimensions.clone(),
                    };
                    let _ = net.send(ClientMessage::SpaceMutate { mutation: command });
                    state.notice = Some(format!("{name} を配置しました ({size} bytes)"));
                }
            }
            ContentEvent::Bytes { cid, bytes } => {
                cache.bytes.insert(cid, bytes);
            }
            ContentEvent::Progress { cid, loaded, total } => {
                if let Some(cid) = cid {
                    state.progress.insert(cid, (loaded, total));
                }
            }
            ContentEvent::Saved { cid, path } => {
                state.log(format!("保存しました: {} ({cid})", path.display()));
            }
            ContentEvent::Failed { cid, message } => {
                bevy::log::warn!("content failed: {message}");
                if cid.is_none() {
                    state.kubo_connected = false;
                }
                state.log(message.clone());
                state.notice = Some(message);
                if let Some(cid) = cid {
                    state.progress.remove(&cid);
                }
            }
            ContentEvent::AvatarUploaded { cid } => {
                config.avatar_cid = Some(cid.clone());
                config.save();
                let command_id = Uuid::new_v4().to_string();
                let _ = net.send(ClientMessage::SpaceSetAvatar {
                    command_id,
                    cid: Some(cid),
                });
                state.notice = Some("アバターを設定しました".into());
                state.log("アバターをサーバーへ送信しました");
            }
            ContentEvent::AvatarUploadFailed { cid, message } => {
                let command_id = Uuid::new_v4().to_string();
                let _ = net.send(ClientMessage::SpaceSetAvatar {
                    command_id,
                    cid: Some(cid),
                });
                state.notice = Some(message.clone());
                state.log(message);
            }
            ContentEvent::UploadFailed { path, message } => {
                pending.by_path.remove(&path);
                if state.avatar_upload.as_ref() == Some(&path) {
                    state.avatar_upload = None;
                }
                state.notice = Some(message.clone());
                state.log(message);
            }
        }
    }

    if !state.avatar_sent && state.status == NetStatus::Online && state.ipfs_peer_id.is_some() {
        let local_path = state
            .avatar_upload
            .clone()
            .or_else(|| config.avatar_path.clone().filter(|path| path.exists()));
        if let Some(path) = local_path {
            state.avatar_upload = Some(path.clone());
            state.avatar_sent = true;
            content.add_file(path);
        } else if let Some(cid) = config.avatar_cid.clone() {
            let command_id = Uuid::new_v4().to_string();
            let _ = net.send(ClientMessage::SpaceSetAvatar {
                command_id,
                cid: Some(cid),
            });
            state.avatar_sent = true;
        }
    }

    if store.dirty {
        state.projected = project_entities(store.entities.values());
        store.dirty = false;
    }
}

fn send_pose(
    net: Option<Res<NetHandle>>,
    state: Res<NetState>,
    player: Option<Res<crate::world::LocalPlayer>>,
    time: Res<Time>,
    mut accumulator: Local<f32>,
) {
    let (Some(net), Some(player)) = (net, player) else {
        return;
    };
    if state.status != NetStatus::Online {
        return;
    }
    *accumulator += time.delta_secs();
    let interval = 1.0 / state.tick_rate.max(1) as f32;
    if *accumulator < interval {
        return;
    }
    *accumulator = 0.0;

    let Some(entity_id) = state.self_entity.clone() else {
        return;
    };
    let head = player.head_quat();
    send_patch(
        net.as_ref(),
        &entity_id,
        json!({
            "space.position": player.position(),
            "space.head": head,
            "space.crouch": player.crouch().round_to_2(),
            "space.lean": player.lean().round_to_2(),
        }),
    );
}

fn update_projection(store: Res<SpaceStore>, mut state: ResMut<NetState>) {
    if store.is_changed() {
        state.projected = project_entities(store.entities.values());
    }
}

pub fn send_patch(net: &NetHandle, entity_id: &str, set: serde_json::Value) {
    let Some(set) = set.as_object() else {
        return;
    };
    let mutation = SpaceMutation::Patch {
        command_id: Uuid::new_v4().to_string(),
        entity_id: entity_id.to_owned(),
        set: Some(set.clone()),
        unset: None,
        conditions: None,
        if_version: None,
    };
    net.send(ClientMessage::SpaceMutate { mutation });
}

pub fn send_claim(net: &NetHandle, entity_id: &str) -> String {
    let command_id = Uuid::new_v4().to_string();
    let mutation = SpaceMutation::Claim {
        command_id: command_id.clone(),
        entity_id: entity_id.to_owned(),
    };
    net.send(ClientMessage::SpaceMutate { mutation });
    command_id
}

pub fn send_release(net: &NetHandle, entity_id: &str) -> String {
    let command_id = Uuid::new_v4().to_string();
    let mutation = SpaceMutation::Release {
        command_id: command_id.clone(),
        entity_id: entity_id.to_owned(),
    };
    net.send(ClientMessage::SpaceMutate { mutation });
    command_id
}

pub fn send_delete(net: &NetHandle, entity_id: &str) -> String {
    let command_id = Uuid::new_v4().to_string();
    let mutation = SpaceMutation::Delete {
        command_id: command_id.clone(),
        entity_id: entity_id.to_owned(),
        conditions: None,
        if_version: None,
    };
    net.send(ClientMessage::SpaceMutate { mutation });
    command_id
}

pub fn send_duplicate(net: &NetHandle, entity_id: &str) -> String {
    let command_id = Uuid::new_v4().to_string();
    let mutation = SpaceMutation::Duplicate {
        command_id: command_id.clone(),
        entity_id: entity_id.to_owned(),
        new_entity_id: Uuid::new_v4().to_string(),
    };
    net.send(ClientMessage::SpaceMutate { mutation });
    command_id
}

fn kubo_addresses(server: &str, ipfs: &space_protocol::messages::IpfsInfo) -> Vec<String> {
    use std::net::ToSocketAddrs;

    let Some(without_scheme) = server.split_once("://").map(|(_, rest)| rest) else {
        return Vec::new();
    };
    let Some(authority) = without_scheme.split('/').next() else {
        return Vec::new();
    };
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.parse::<u16>().is_ok() => host,
        _ => authority,
    };
    let secure = server.starts_with("wss://");
    let ws_protocol = if secure { "/wss" } else { "/ws" };
    let mut addresses = Vec::new();

    // Kubo の swarm は TCP 4001 で公開されている。TLS WebSocket より
    // 経路が単純で、Caddy の証明書や SNI に依存しない。
    let mut resolved = Vec::new();
    if let Ok(iter) = (host, 0).to_socket_addrs() {
        for address in iter {
            let ip = address.ip();
            if resolved.contains(&ip) {
                continue;
            }
            resolved.push(ip);
            let ip_part = match ip {
                std::net::IpAddr::V4(ip) => format!("/ip4/{ip}"),
                std::net::IpAddr::V6(ip) => format!("/ip6/{ip}"),
            };
            addresses.push(format!("{ip_part}/tcp/4001/p2p/{}", ipfs.peer_id));
            if !secure {
                addresses.push(format!(
                    "{ip_part}/tcp/{}{ws_protocol}/p2p/{}",
                    ipfs.ws_port, ipfs.peer_id
                ));
            }
        }
    }

    // DNS 名を直接使う経路も残す。libp2p の DNS transport が
    // WebSocket を解決できない環境があるため、必須ではない。
    if resolved.is_empty() {
        addresses.push(format!(
            "/dns4/{host}/tcp/{}{ws_protocol}/p2p/{}",
            ipfs.ws_port, ipfs.peer_id
        ));
    }
    addresses
}

trait RoundTo2 {
    fn round_to_2(self) -> f64;
}

impl RoundTo2 for f32 {
    fn round_to_2(self) -> f64 {
        ((self * 100.0).round() / 100.0) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use space_protocol::messages::IpfsInfo;

    #[test]
    fn kubo_addresses_prefer_tcp_swarm() {
        let ipfs = IpfsInfo {
            peer_id: "peer".into(),
            ws_port: 8443,
        };
        let addresses = kubo_addresses("ws://127.0.0.1:8080/ws", &ipfs);
        assert_eq!(addresses[0], "/ip4/127.0.0.1/tcp/4001/p2p/peer");
        assert!(
            addresses
                .iter()
                .any(|address| address == "/ip4/127.0.0.1/tcp/8443/ws/p2p/peer")
        );
    }
}
