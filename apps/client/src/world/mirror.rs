use std::f32::consts::FRAC_PI_2;

use bevy::asset::RenderAssetUsages;
use bevy::camera::RenderTarget;
use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages};

use crate::world::LocalPlayer;

const MIRROR_SIZE: u32 = 1024;
const MIRROR_DISTANCE: f32 = 2.8;
const MIRROR_HEIGHT: f32 = 1.35;

#[derive(Resource, Default)]
pub struct MirrorState {
    pub enabled: bool,
}

#[derive(Component)]
struct MirrorCamera;

#[derive(Component)]
struct MirrorPlane;

pub struct MirrorPlugin;

impl Plugin for MirrorPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<MirrorState>()
            .add_systems(Startup, setup_mirror)
            .add_systems(
                Update,
                (toggle_mirror, update_mirror)
                    .chain()
                    .run_if(in_state(crate::AppState::InWorld)),
            );
    }
}

fn setup_mirror(
    mut commands: Commands,
    mut images: ResMut<Assets<Image>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let mut image = Image::new_uninit(
        Extent3d {
            width: MIRROR_SIZE,
            height: MIRROR_SIZE,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        TextureFormat::Bgra8UnormSrgb,
        RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
    );
    image.texture_descriptor.usage |=
        TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST | TextureUsages::RENDER_ATTACHMENT;
    let image = images.add(image);

    commands.spawn((
        Camera3d::default(),
        Camera {
            order: -1,
            is_active: false,
            ..default()
        },
        RenderTarget::Image(image.clone().into()),
        Transform::from_xyz(0.0, MIRROR_HEIGHT, -MIRROR_DISTANCE),
        RenderLayers::from_layers(&[0, 1]),
        MirrorCamera,
    ));

    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(2.2, 2.2))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color_texture: Some(image.clone()),
            unlit: true,
            cull_mode: None,
            ..default()
        })),
        Transform::from_xyz(0.0, MIRROR_HEIGHT, -MIRROR_DISTANCE)
            .with_rotation(Quat::from_rotation_x(FRAC_PI_2)),
        Visibility::Hidden,
        RenderLayers::layer(2),
        MirrorPlane,
    ));
}

fn toggle_mirror(keys: Res<ButtonInput<KeyCode>>, mut state: ResMut<MirrorState>) {
    if keys.just_pressed(KeyCode::KeyV) {
        state.enabled = !state.enabled;
    }
}

fn update_mirror(
    player: Res<LocalPlayer>,
    state: Res<MirrorState>,
    mut camera: Query<(&mut Camera, &mut Transform), (With<MirrorCamera>, Without<MirrorPlane>)>,
    mut plane: Query<(&mut Transform, &mut Visibility), (With<MirrorPlane>, Without<MirrorCamera>)>,
) {
    let Some((mut camera, mut camera_transform)) = camera.iter_mut().next() else {
        return;
    };
    camera.is_active = state.enabled;

    let Some((mut plane_transform, mut visibility)) = plane.iter_mut().next() else {
        return;
    };
    *visibility = if state.enabled {
        Visibility::Visible
    } else {
        Visibility::Hidden
    };
    if !state.enabled {
        return;
    }

    let forward = player.rotation() * Vec3::NEG_Z;
    let flat = Vec3::new(forward.x, 0.0, forward.z);
    let forward = if flat.length_squared() > 1e-6 {
        flat.normalize()
    } else {
        Vec3::NEG_Z
    };
    let yaw = forward.x.atan2(-forward.z);
    let position = Vec3::new(
        player.position.x + forward.x * MIRROR_DISTANCE,
        player.position.y + MIRROR_HEIGHT,
        player.position.z + forward.z * MIRROR_DISTANCE,
    );

    *plane_transform = Transform {
        translation: position,
        rotation: Quat::from_rotation_y(yaw) * Quat::from_rotation_x(FRAC_PI_2),
        scale: Vec3::ONE,
    };

    let target = Vec3::new(player.head_x, player.eye_y, player.head_z);
    *camera_transform =
        Transform::from_translation(position + forward * 0.03).looking_at(target, Vec3::Y);
}
