use std::collections::{HashMap, HashSet};
use std::f32::consts::PI;
use std::path::PathBuf;

use bevy::prelude::*;
use bevy_vrm::loader::Vrm;
use bevy_vrm::{VrmInstance, VrmInstanceReady};

use crate::content::ContentService;
use crate::net::NetState;
use crate::world::avatars::PeerVisuals;

#[derive(Debug)]
struct Entry {
    cid: String,
    child: Entity,
    handle: Handle<Vrm>,
    reported: bool,
}

#[derive(Resource, Default)]
pub struct VrmCache {
    handles: HashMap<String, Handle<Vrm>>,
    requested: HashSet<String>,
    failed: HashSet<String>,
    entries: HashMap<String, Entry>,
}

pub struct VrmPlugin;

impl Plugin for VrmPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<VrmCache>().add_systems(
            Update,
            sync_peer_vrms.run_if(in_state(crate::AppState::InWorld)),
        );
    }
}

fn cache_path(cid: &str) -> PathBuf {
    crate::config::project_dirs()
        .map(|dirs| dirs.cache_dir().join("assets").join("vrm"))
        .unwrap_or_else(|| PathBuf::from("assets/vrm"))
        .join(format!("{cid}.vrm"))
}

#[allow(clippy::too_many_arguments)]
fn sync_peer_vrms(
    mut commands: Commands,
    asset_server: Res<AssetServer>,
    content: Res<ContentService>,
    state: Res<NetState>,
    peers: Res<PeerVisuals>,
    mut cache: ResMut<VrmCache>,
    ready: Query<(), With<VrmInstanceReady>>,
) {
    let self_id = state.self_entity.as_deref();

    for (peer_id, peer) in &state.projected.peers {
        if Some(peer_id.as_str()) == self_id {
            continue;
        }
        let Some(cid) = peer.avatar_cid.clone() else {
            if let Some(entry) = cache.entries.remove(peer_id) {
                commands.entity(entry.child).try_despawn();
                restore_capsule(&mut commands, &peers, peer_id);
            }
            continue;
        };

        if cache.failed.contains(&cid) {
            continue;
        }

        if let Some(entry) = cache.entries.get_mut(peer_id) {
            if entry.cid == cid {
                if matches!(
                    asset_server.get_load_state(&entry.handle),
                    Some(bevy::asset::LoadState::Failed(_))
                ) {
                    bevy::log::warn!("VRM load failed: {peer_id} ({cid})");
                    commands.entity(entry.child).try_despawn();
                    cache.entries.remove(peer_id);
                    cache.handles.remove(&cid);
                    cache.requested.remove(&cid);
                    cache.failed.insert(cid.clone());
                    let path = cache_path(&cid);
                    if path.exists() {
                        let _ = std::fs::remove_file(path);
                    }
                    restore_capsule(&mut commands, &peers, peer_id);
                    continue;
                }
                if ready.get(entry.child).is_ok() {
                    if !entry.reported {
                        entry.reported = true;
                        bevy::log::info!("VRM ready: {peer_id} ({cid})");
                    }
                    hide_capsule(&mut commands, &peers, peer_id);
                }
                continue;
            }
            commands.entity(entry.child).try_despawn();
            cache.entries.remove(peer_id);
            restore_capsule(&mut commands, &peers, peer_id);
        }

        let Some(root) = peers.root(peer_id) else {
            continue;
        };

        let handle = if let Some(handle) = cache.handles.get(&cid) {
            handle.clone()
        } else {
            let path = cache_path(&cid);
            if path.exists() {
                bevy::log::info!("loading VRM: {peer_id} ({cid})");
                let handle = asset_server.load(format!("vrm/{cid}.vrm"));
                cache.handles.insert(cid.clone(), handle.clone());
                handle
            } else {
                if cache.requested.insert(cid.clone()) {
                    bevy::log::info!("fetching VRM: {peer_id} ({cid})");
                    content.fetch_to(cid.clone(), path);
                }
                continue;
            }
        };

        let child = commands
            .spawn((
                Transform::from_rotation(Quat::from_rotation_y(PI)),
                VrmInstance(handle.clone()),
            ))
            .id();
        commands.entity(root).add_child(child);
        cache.entries.insert(
            peer_id.clone(),
            Entry {
                cid,
                child,
                handle,
                reported: false,
            },
        );
    }

    let live: HashSet<&str> = state.projected.peers.keys().map(String::as_str).collect();
    cache.entries.retain(|peer_id, entry| {
        if !live.contains(peer_id.as_str()) {
            commands.entity(entry.child).try_despawn();
            false
        } else {
            true
        }
    });
}

fn hide_capsule(commands: &mut Commands, peers: &PeerVisuals, peer_id: &str) {
    if let Some((body, head)) = peers.body_head(peer_id) {
        commands.entity(body).insert(Visibility::Hidden);
        commands.entity(head).insert(Visibility::Hidden);
    }
}

fn restore_capsule(commands: &mut Commands, peers: &PeerVisuals, peer_id: &str) {
    if let Some((body, head)) = peers.body_head(peer_id) {
        commands.entity(body).insert(Visibility::Inherited);
        commands.entity(head).insert(Visibility::Inherited);
    }
}
