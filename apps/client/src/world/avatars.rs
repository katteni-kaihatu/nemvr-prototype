use std::collections::{HashMap, HashSet};

use bevy::prelude::*;
use space_protocol::projection::{Pose, pose_from_entity};

use crate::net::interpolation::PoseBuffer;
use crate::net::{NetState, store::SpaceStore};
use crate::world::objects::{SharedAssets, parse_color};

#[derive(Component)]
pub struct PeerVisual;

#[derive(Component)]
pub struct PeerBody;

#[derive(Component)]
pub struct PeerHead;

struct Entry {
    root: Entity,
    body: Entity,
    head: Entity,
    name_label: Entity,
    buffer: PoseBuffer,
    last_version: u64,
    last_name: String,
    last_color: String,
}

#[derive(Resource, Default)]
pub struct PeerVisuals {
    entries: HashMap<String, Entry>,
}

pub fn sync_avatars(
    mut commands: Commands,
    state: Res<NetState>,
    store: Res<SpaceStore>,
    assets: Res<SharedAssets>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut visuals: ResMut<PeerVisuals>,
) {
    let self_id = state.self_entity.as_deref();
    let mut seen = HashSet::new();

    for (id, peer) in &state.projected.peers {
        if Some(id.as_str()) == self_id {
            continue;
        }
        seen.insert(id.clone());

        let entity = store.get(id);
        let version = entity.map_or(0, |entity| entity.version);
        let pose = entity.map(pose_from_entity).unwrap_or_default();

        if let Some(entry) = visuals.entries.get_mut(id) {
            if entry.last_version != version {
                entry.buffer.push(state.server_now(), pose);
                entry.last_version = version;
            }
            let sampled = entry
                .buffer
                .sample(state.server_now() - space_protocol::INTERPOLATION_DELAY_MS)
                .unwrap_or(pose);
            apply_pose(&mut commands, entry, sampled);
            if entry.last_name != peer.name {
                commands
                    .entity(entry.name_label)
                    .insert(Text2d::new(peer.name.clone()));
                entry.last_name = peer.name.clone();
            }
            if entry.last_color != peer.color {
                commands
                    .entity(entry.body)
                    .insert(MeshMaterial3d(materials.add(StandardMaterial {
                        base_color: parse_color(&peer.color),
                        perceptual_roughness: 0.7,
                        ..default()
                    })));
                entry.last_color = peer.color.clone();
            }
            continue;
        }

        let body = commands
            .spawn((
                Mesh3d(assets.capsule.clone()),
                MeshMaterial3d(materials.add(StandardMaterial {
                    base_color: parse_color(&peer.color),
                    perceptual_roughness: 0.7,
                    ..default()
                })),
                Transform::from_xyz(0.0, 0.65, 0.0),
                PeerBody,
            ))
            .id();
        let head = commands
            .spawn((
                Mesh3d(assets.sphere.clone()),
                MeshMaterial3d(materials.add(StandardMaterial {
                    base_color: Color::srgb(0.82, 0.72, 0.62),
                    perceptual_roughness: 0.8,
                    ..default()
                })),
                Transform::from_xyz(0.0, 1.45, 0.0),
                PeerHead,
            ))
            .id();
        let name_label = commands
            .spawn((
                Text2d::new(peer.name.clone()),
                TextFont {
                    font_size: FontSize::Px(22.0),
                    ..default()
                },
                TextColor(Color::WHITE),
                Transform::from_xyz(0.0, 1.85, 0.0),
            ))
            .id();
        let root = commands
            .spawn((
                Transform::from_translation(Vec3::from(pose.position)),
                Visibility::default(),
                PeerVisual,
            ))
            .id();
        commands
            .entity(root)
            .add_children(&[body, head, name_label]);

        let mut entry = Entry {
            root,
            body,
            head,
            name_label,
            buffer: PoseBuffer::default(),
            last_version: version,
            last_name: peer.name.clone(),
            last_color: peer.color.clone(),
        };
        entry.buffer.push(state.server_now(), pose);
        visuals.entries.insert(id.clone(), entry);
    }

    let stale: Vec<_> = visuals
        .entries
        .iter()
        .filter(|(id, _)| !seen.contains(*id))
        .map(|(id, entry)| (id.clone(), entry.root))
        .collect();
    for (id, entity) in stale {
        commands.entity(entity).despawn();
        visuals.entries.remove(&id);
    }
}

fn apply_pose(commands: &mut Commands, entry: &mut Entry, pose: Pose) {
    let head = Quat::from_array(pose.head);
    let forward = head * Vec3::NEG_Z;
    let yaw = (-forward.x).atan2(-forward.z);
    let crouch = pose.crouch.clamp(0.0, 1.0);

    commands.entity(entry.root).insert(Transform {
        translation: Vec3::from(pose.position),
        rotation: Quat::from_rotation_y(yaw),
        scale: Vec3::ONE,
    });
    commands.entity(entry.body).insert(Transform {
        translation: Vec3::new(0.0, 0.65 - crouch * 0.25, 0.0),
        scale: Vec3::new(1.0, 1.0 - crouch * 0.35, 1.0),
        ..default()
    });
    commands.entity(entry.head).insert(Transform {
        translation: Vec3::new(0.0, 1.45 - crouch * 0.5, 0.0),
        rotation: Quat::from_rotation_y(-yaw) * head,
        ..default()
    });
    commands.entity(entry.name_label).insert(Transform {
        translation: Vec3::new(0.0, 1.85 - crouch * 0.5, 0.0),
        ..default()
    });
}
