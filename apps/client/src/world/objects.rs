use std::collections::{HashMap, HashSet};

use bevy::asset::RenderAssetUsages;
use bevy::prelude::*;
use space_protocol::projection::{FileCategory, FileObject, WorldObject};

use crate::content::ContentService;
use crate::net::{ContentCache, NetState};
use crate::world::LocalPlayer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisualKind {
    Image,
    File,
    Link,
    Box,
}

#[derive(Component)]
pub struct ObjectVisual {
    pub id: String,
    pub mesh: Entity,
}

#[derive(Resource)]
pub struct SharedAssets {
    pub cube: Handle<Mesh>,
    pub plane: Handle<Mesh>,
    pub capsule: Handle<Mesh>,
    pub sphere: Handle<Mesh>,
}

#[derive(Resource, Default)]
pub struct ImageMaterials {
    pub by_cid: HashMap<String, Handle<StandardMaterial>>,
    pub loaded: HashSet<String>,
}

#[derive(Resource, Default)]
pub struct ObjectVisuals {
    pub by_id: HashMap<String, Entity>,
}

pub fn setup_assets(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>) {
    commands.insert_resource(SharedAssets {
        cube: meshes.add(Cuboid::new(1.0, 1.0, 1.0)),
        plane: meshes.add(Plane3d::default().mesh().size(1.0, 1.0)),
        capsule: meshes.add(Capsule3d::new(0.25, 0.8)),
        sphere: meshes.add(Sphere::new(0.18)),
    });
    commands.init_resource::<ObjectVisuals>();
    commands.init_resource::<ImageMaterials>();
}

pub fn sync_objects(
    mut commands: Commands,
    state: Res<NetState>,
    player: Res<LocalPlayer>,
    assets: Res<SharedAssets>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut visuals: ResMut<ObjectVisuals>,
) {
    let mut seen = HashSet::new();

    for (id, object) in &state.projected.objects {
        seen.insert(id.clone());
        let base = object.base();
        let kind = match object {
            WorldObject::Image(_) => VisualKind::Image,
            WorldObject::File(_) => VisualKind::File,
            WorldObject::Link(_) => VisualKind::Link,
            WorldObject::Box(_) => VisualKind::Box,
        };
        let (width, height, depth) = dimensions(object);

        if let Some(entity) = visuals.by_id.get(id).copied() {
            // 自分がつかんでいる間は interaction が直接動かす。
            if player.grabbed_id.as_deref() != Some(id.as_str()) {
                commands.entity(entity).insert(Transform {
                    translation: Vec3::from(base.position),
                    rotation: Quat::from_euler(EulerRot::YXZ, base.yaw, base.pitch, 0.0),
                    scale: Vec3::splat(base.scale.max(0.01)),
                });
            }
            continue;
        }

        let material = match object {
            WorldObject::Box(box_object) => materials.add(StandardMaterial {
                base_color: parse_color(&box_object.color),
                perceptual_roughness: 0.8,
                ..default()
            }),
            WorldObject::Image(_) => materials.add(StandardMaterial {
                base_color: Color::srgb(0.45, 0.45, 0.45),
                unlit: true,
                alpha_mode: AlphaMode::Blend,
                cull_mode: None,
                ..default()
            }),
            WorldObject::File(file) => materials.add(StandardMaterial {
                base_color: file_color(file),
                perceptual_roughness: 0.65,
                ..default()
            }),
            WorldObject::Link(_) => materials.add(StandardMaterial {
                base_color: Color::srgb(0.20, 0.38, 0.58),
                perceptual_roughness: 0.6,
                ..default()
            }),
        };

        let mesh = match kind {
            VisualKind::Box | VisualKind::File | VisualKind::Link => assets.cube.clone(),
            VisualKind::Image => assets.plane.clone(),
        };

        let mesh_transform = match kind {
            VisualKind::Box => Transform::from_xyz(0.0, height * 0.5, 0.0)
                .with_scale(Vec3::new(width, height, depth)),
            VisualKind::Image => Transform::from_xyz(0.0, height * 0.5, 0.0)
                .with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2))
                .with_scale(Vec3::new(width, 1.0, height)),
            VisualKind::File | VisualKind::Link => Transform::from_xyz(0.0, height * 0.5, 0.0)
                .with_scale(Vec3::new(width, height, depth)),
        };

        let mesh_entity = commands
            .spawn((Mesh3d(mesh), MeshMaterial3d(material), mesh_transform))
            .id();

        if let Some(label) = object_label(object) {
            let label_entity = commands
                .spawn((
                    Text2d::new(label),
                    TextFont {
                        font_size: FontSize::Px(22.0),
                        ..default()
                    },
                    TextColor(Color::WHITE),
                    Transform::from_xyz(0.0, height + 0.12, 0.04),
                ))
                .id();
            commands.entity(mesh_entity).add_child(label_entity);
        }

        let root = commands
            .spawn((
                Transform {
                    translation: Vec3::from(base.position),
                    rotation: Quat::from_euler(EulerRot::YXZ, base.yaw, base.pitch, 0.0),
                    scale: Vec3::splat(base.scale.max(0.01)),
                },
                Visibility::default(),
                ObjectVisual {
                    id: id.clone(),
                    mesh: mesh_entity,
                },
            ))
            .id();
        commands.entity(root).add_child(mesh_entity);
        visuals.by_id.insert(id.clone(), root);
    }

    let stale: Vec<_> = visuals
        .by_id
        .iter()
        .filter(|(id, _)| !seen.contains(*id))
        .map(|(id, entity)| (id.clone(), *entity))
        .collect();
    for (id, entity) in stale {
        commands.entity(entity).despawn();
        visuals.by_id.remove(&id);
    }
}

pub fn load_images(
    content: Res<ContentService>,
    state: Res<NetState>,
    mut cache: ResMut<ContentCache>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut images: ResMut<Assets<Image>>,
    mut image_materials: ResMut<ImageMaterials>,
    mut visuals: Query<&mut MeshMaterial3d<StandardMaterial>>,
    object_visuals: Query<&ObjectVisual>,
) {
    for object in state.projected.objects.values() {
        let WorldObject::Image(image) = object else {
            continue;
        };
        if image.cid.is_empty() || image_materials.loaded.contains(&image.cid) {
            continue;
        }

        if let Some(bytes) = cache.bytes.get(&image.cid) {
            let Ok(dynamic) = image::load_from_memory(bytes) else {
                image_materials.loaded.insert(image.cid.clone());
                continue;
            };
            let texture = Image::from_dynamic(dynamic, true, RenderAssetUsages::default());
            let handle = images.add(texture);
            let material = materials.add(StandardMaterial {
                base_color_texture: Some(handle),
                unlit: true,
                alpha_mode: AlphaMode::Blend,
                cull_mode: None,
                ..default()
            });
            image_materials
                .by_cid
                .insert(image.cid.clone(), material.clone());
            image_materials.loaded.insert(image.cid.clone());

            for (entity, visual) in object_visuals.iter().map(|v| (v.mesh, v)) {
                if visual.id == image.base.id
                    && let Ok(mut material_handle) = visuals.get_mut(entity)
                {
                    material_handle.0 = material.clone();
                }
            }
            continue;
        }

        if cache.requested.insert(image.cid.clone()) {
            content.fetch(image.cid.clone());
        }
    }
}

fn dimensions(object: &WorldObject) -> (f32, f32, f32) {
    match object {
        WorldObject::Box(o) => (o.size, o.size, o.size),
        WorldObject::Image(o) => (o.width, o.height, 0.02),
        WorldObject::File(_) | WorldObject::Link(_) => (
            space_protocol::FILE_ICON_WIDTH,
            space_protocol::FILE_ICON_HEIGHT,
            0.06,
        ),
    }
}

fn object_label(object: &WorldObject) -> Option<String> {
    match object {
        WorldObject::File(file) => Some(truncate(&file.name, 24)),
        WorldObject::Link(link) => Some(truncate(&link.url, 24)),
        _ => None,
    }
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn file_color(file: &FileObject) -> Color {
    match file.category {
        FileCategory::Audio => Color::srgb(0.45, 0.32, 0.55),
        FileCategory::Video => Color::srgb(0.55, 0.34, 0.28),
        FileCategory::File => Color::srgb(0.30, 0.38, 0.46),
    }
}

pub fn parse_color(value: &str) -> Color {
    let value = value.trim_start_matches('#');
    if value.len() == 6
        && value.is_ascii()
        && let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&value[0..2], 16),
            u8::from_str_radix(&value[2..4], 16),
            u8::from_str_radix(&value[4..6], 16),
        )
    {
        return Color::srgb_u8(r, g, b);
    }
    Color::srgb(0.5, 0.5, 0.5)
}
