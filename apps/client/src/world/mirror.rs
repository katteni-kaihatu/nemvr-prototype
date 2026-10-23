use std::f32::consts::FRAC_PI_2;

use bevy::asset::RenderAssetUsages;
use bevy::camera::RenderTarget;
use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages};

const MIRROR_SIZE: u32 = 1024;
/// 固定された鏡の位置。プレイヤーについてこない。
const MIRROR_POSITION: Vec3 = Vec3::new(0.0, 1.35, -2.8);

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
            invert_culling: true,
            ..default()
        },
        RenderTarget::Image(image.clone().into()),
        Transform::from_translation(MIRROR_POSITION).looking_at(Vec3::ZERO, Vec3::Y),
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
        Transform::from_translation(MIRROR_POSITION)
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
    state: Res<MirrorState>,
    main_camera: Query<&Transform, (With<crate::world::scene::MainCamera>, Without<MirrorCamera>)>,
    mut camera: Query<
        (&mut Camera, &mut Transform),
        (With<MirrorCamera>, Without<crate::world::scene::MainCamera>),
    >,
) {
    let Some((mut camera, mut camera_transform)) = camera.iter_mut().next() else {
        return;
    };
    camera.is_active = state.enabled;
    if !state.enabled {
        return;
    }

    let Some(main) = main_camera.iter().next() else {
        return;
    };
    let normal = Vec3::Z;
    let position = MIRROR_POSITION;
    let reflected_position =
        main.translation - 2.0 * (main.translation - position).dot(normal) * normal;
    let forward = main.rotation * Vec3::NEG_Z;
    let up = main.rotation * Vec3::Y;
    let reflected_forward = forward - 2.0 * forward.dot(normal) * normal;
    let reflected_up = up - 2.0 * up.dot(normal) * normal;
    let reflected_up = if reflected_up.length_squared() > 1e-6 {
        reflected_up
    } else {
        Vec3::Y
    };

    *camera_transform = Transform::from_translation(reflected_position)
        .looking_at(reflected_position + reflected_forward, reflected_up);
}
