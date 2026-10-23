use std::collections::{HashMap, HashSet};
use std::f32::consts::PI;
use std::path::PathBuf;

use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;
use bevy_vrm::loader::Vrm;
use bevy_vrm::{VrmInstance, VrmInstanceReady};

use crate::config::ClientConfig;
use crate::content::ContentService;
use crate::net::NetState;
use crate::world::LocalPlayer;
use crate::world::avatars::PeerVisuals;

#[derive(Debug)]
struct Entry {
    cid: String,
    child: Entity,
    handle: Handle<Vrm>,
    reported: bool,
}

#[derive(Resource, Default)]
struct SelfAvatarState {
    root: Option<Entity>,
    capsule: Vec<Entity>,
    vrm: Option<Entity>,
    cid: Option<String>,
    hiding_capsule: bool,
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
        app.init_resource::<VrmCache>()
            .init_resource::<SelfAvatarState>()
            .add_systems(Startup, spawn_self_avatar)
            .add_systems(
                Update,
                (sync_self_avatar, sync_peer_vrms)
                    .chain()
                    .run_if(in_state(crate::AppState::InWorld)),
            );
    }
}

fn spawn_self_avatar(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut state: ResMut<SelfAvatarState>,
) {
    let material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.62, 0.66, 0.7),
        perceptual_roughness: 0.8,
        ..default()
    });
    let body = commands
        .spawn((
            Mesh3d(meshes.add(Capsule3d::new(0.25, 0.8))),
            MeshMaterial3d(material.clone()),
            Transform::from_xyz(0.0, 0.65, 0.0),
            RenderLayers::layer(1),
        ))
        .id();
    let head = commands
        .spawn((
            Mesh3d(meshes.add(Sphere::new(0.18))),
            MeshMaterial3d(material),
            Transform::from_xyz(0.0, 1.45, 0.0),
            RenderLayers::layer(1),
        ))
        .id();
    let root = commands
        .spawn((
            Transform::IDENTITY,
            Visibility::default(),
            RenderLayers::layer(1),
        ))
        .id();
    commands.entity(root).add_children(&[body, head]);
    state.root = Some(root);
    state.capsule = vec![body, head];
}

fn sync_self_avatar(
    mut commands: Commands,
    asset_server: Res<AssetServer>,
    config: Res<ClientConfig>,
    player: Res<LocalPlayer>,
    mut state: ResMut<SelfAvatarState>,
    ready: Query<(), With<VrmInstanceReady>>,
    children: Query<&Children>,
) {
    let Some(root) = state.root else {
        return;
    };
    commands.entity(root).insert(Transform {
        translation: player.position,
        rotation: Quat::from_rotation_y(player.yaw),
        scale: Vec3::ONE,
    });

    if let Some(cid) = config.avatar_cid.clone() {
        if state.cid.as_deref() != Some(cid.as_str()) {
            if let Some(old) = state.vrm.take() {
                commands.entity(old).try_despawn();
            }
            state.cid = Some(cid.clone());
            for entity in &state.capsule {
                commands.entity(*entity).insert(Visibility::Inherited);
            }
            state.hiding_capsule = false;
            let path = cache_path(&cid);
            if path.exists() {
                let vrm = commands
                    .spawn((
                        Transform::from_rotation(Quat::from_rotation_y(std::f32::consts::PI)),
                        VrmInstance(asset_server.load(format!("vrm/{cid}.vrm"))),
                        RenderLayers::layer(1),
                    ))
                    .id();
                commands.entity(root).add_child(vrm);
                state.vrm = Some(vrm);
            }
        }

        if let Some(vrm) = state.vrm {
            tag_layers(&mut commands, vrm, &children);
            if ready.get(vrm).is_ok() {
                if !state.hiding_capsule {
                    for entity in &state.capsule {
                        commands.entity(*entity).insert(Visibility::Hidden);
                    }
                    state.hiding_capsule = true;
                }
            }
        }
    } else if state.vrm.is_none() && state.hiding_capsule {
        for entity in &state.capsule {
            commands.entity(*entity).insert(Visibility::Inherited);
        }
        state.hiding_capsule = false;
    }
}

fn tag_layers(commands: &mut Commands, root: Entity, children: &Query<&Children>) {
    let mut stack = vec![root];
    while let Some(entity) = stack.pop() {
        commands.entity(entity).insert(RenderLayers::layer(1));
        if let Ok(list) = children.get(entity) {
            stack.extend(list.iter());
        }
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
