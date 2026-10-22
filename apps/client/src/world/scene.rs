use bevy::prelude::*;
use bevy::ui::IsDefaultUiCamera;

#[derive(Component)]
pub struct MainCamera;

pub fn setup_scene(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    commands.spawn((
        Camera3d::default(),
        MainCamera,
        IsDefaultUiCamera,
        Transform::from_xyz(0.0, 1.6, 4.0).looking_at(Vec3::new(0.0, 1.4, 0.0), Vec3::Y),
    ));

    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(50.0, 50.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.23, 0.28, 0.23),
            perceptual_roughness: 0.95,
            ..default()
        })),
        Transform::default(),
    ));

    commands.spawn((
        DirectionalLight {
            illuminance: 12_000.0,
            shadow_maps_enabled: true,
            ..default()
        },
        Transform::from_xyz(12.0, 20.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));

    commands.insert_resource(GlobalAmbientLight {
        color: Color::srgb(0.6, 0.7, 0.9),
        brightness: 450.0,
        ..default()
    });
}

pub fn draw_grid(mut gizmos: Gizmos) {
    let half = 24;
    for i in -half..=half {
        let i = i as f32;
        let color = if i == 0.0 {
            Color::srgba(0.7, 0.8, 0.9, 0.5)
        } else {
            Color::srgba(0.55, 0.62, 0.55, 0.18)
        };
        gizmos.line(
            Vec3::new(-half as f32, 0.002, i),
            Vec3::new(half as f32, 0.002, i),
            color,
        );
        gizmos.line(
            Vec3::new(i, 0.002, -half as f32),
            Vec3::new(i, 0.002, half as f32),
            color,
        );
    }
}
