use bevy::input::mouse::MouseMotion;
use bevy::prelude::*;
use bevy::window::{CursorGrabMode, CursorOptions};

use crate::net::NetState;
use crate::world::collision::{body_height_for, collider_for, overlaps_any, resolve_player};
use crate::world::movement::{
    VerticalInput, WALK_SPEED, WORLD_HALF_SIZE, eye_height_for, lean_pose, move_speed_factor,
    step_lean, step_vertical,
};
use crate::world::{LocalPlayer, RingMenu, scene::MainCamera};

const MOUSE_SENSITIVITY: f32 = 0.0022;
const MAX_PITCH: f32 = std::f32::consts::FRAC_PI_2 - 0.01;

pub fn lock_cursor(
    mut cursor_options: Single<&mut CursorOptions>,
    mouse: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
) {
    if mouse.just_pressed(MouseButton::Left) && cursor_options.grab_mode == CursorGrabMode::None {
        cursor_options.grab_mode = CursorGrabMode::Locked;
        cursor_options.visible = false;
    }
    if keys.just_pressed(KeyCode::Escape) {
        cursor_options.grab_mode = CursorGrabMode::None;
        cursor_options.visible = true;
    }
}

pub fn update_player(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    cursor_options: Single<&CursorOptions>,
    mut motions: MessageReader<MouseMotion>,
    state: Res<NetState>,
    menu: Res<RingMenu>,
    mut player: ResMut<LocalPlayer>,
    mut camera: Query<&mut Transform, With<MainCamera>>,
) {
    let locked = cursor_options.grab_mode != CursorGrabMode::None;
    if locked && player.grabbed_id.is_none() {
        for motion in motions.read() {
            player.yaw -= motion.delta.x * MOUSE_SENSITIVITY;
            player.pitch =
                (player.pitch - motion.delta.y * MOUSE_SENSITIVITY).clamp(-MAX_PITCH, MAX_PITCH);
        }
    } else {
        motions.clear();
    }

    let dt = time.delta_secs().min(0.05);
    let menu_open = menu.target.is_some();
    if keys.just_pressed(KeyCode::Space) {
        player.pending_jump = true;
    }

    let grabbable = player.grabbed_id.is_some();
    let colliders: Vec<_> = state
        .projected
        .objects
        .values()
        .filter(|object| object.base().held_by.is_none())
        .filter(|object| Some(object.id()) != player.grabbed_id.as_deref())
        .filter_map(collider_for)
        .collect();

    let jump_pressed = !menu_open && player.pending_jump;
    player.pending_jump = false;
    let mut crouch_wanted = !menu_open
        && (keys.pressed(KeyCode::KeyC)
            || keys.pressed(KeyCode::ControlLeft)
            || keys.pressed(KeyCode::ControlRight));
    if !crouch_wanted
        && player.vertical.crouch > 0.02
        && overlaps_any(
            player.position,
            body_height_for(eye_height_for(0.0)),
            &colliders,
        )
    {
        crouch_wanted = true;
    }

    let vertical = step_vertical(
        player.vertical,
        VerticalInput {
            jump: !menu_open && (keys.pressed(KeyCode::Space) || jump_pressed),
            jump_pressed,
            crouch: crouch_wanted,
        },
        dt,
    );
    player.vertical = vertical;
    player.position.y = vertical.y;

    let lean_direction = if menu_open {
        0.0
    } else {
        (if keys.pressed(KeyCode::KeyE) && !grabbable {
            1.0
        } else {
            0.0
        }) - if keys.pressed(KeyCode::KeyQ) {
            1.0
        } else {
            0.0
        }
    };
    player.lean = step_lean(player.lean, lean_direction, dt.min(0.05));

    let forward = (keys.pressed(KeyCode::KeyW) || keys.pressed(KeyCode::ArrowUp)) as i32
        - (keys.pressed(KeyCode::KeyS) || keys.pressed(KeyCode::ArrowDown)) as i32;
    let right = (keys.pressed(KeyCode::KeyD) || keys.pressed(KeyCode::ArrowRight)) as i32
        - (keys.pressed(KeyCode::KeyA) || keys.pressed(KeyCode::ArrowLeft)) as i32;

    if !menu_open && (forward != 0 || right != 0) {
        let length = ((forward * forward + right * right) as f32).sqrt();
        let sprinting = keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight);
        let step = WALK_SPEED * move_speed_factor(player.vertical.crouch, sprinting) * dt / length;
        let (sin, cos) = player.yaw.sin_cos();
        player.position.x += (-sin * forward as f32 + cos * right as f32) * step;
        player.position.z += (-cos * forward as f32 - sin * right as f32) * step;
        player.position.x = player.position.x.clamp(-WORLD_HALF_SIZE, WORLD_HALF_SIZE);
        player.position.z = player.position.z.clamp(-WORLD_HALF_SIZE, WORLD_HALF_SIZE);
    }

    let resolved = resolve_player(
        player.position,
        body_height_for(eye_height_for(player.vertical.crouch)),
        &colliders,
    );
    player.position.x = resolved.position.x.clamp(-WORLD_HALF_SIZE, WORLD_HALF_SIZE);
    player.position.y = resolved.position.y.max(0.0);
    player.position.z = resolved.position.z.clamp(-WORLD_HALF_SIZE, WORLD_HALF_SIZE);
    if resolved.grounded {
        player.vertical.grounded = true;
        player.vertical.y = player.position.y;
        if player.vertical.vy < 0.0 {
            player.vertical.vy = 0.0;
        }
    }
    if resolved.hit_ceiling && player.vertical.vy > 0.0 {
        player.vertical.vy = 0.0;
    }

    let lean = lean_pose(eye_height_for(player.vertical.crouch), player.lean);
    player.eye_y = player.position.y + lean.height;
    player.head_x = player.position.x + player.yaw.cos() * lean.side;
    player.head_z = player.position.z - player.yaw.sin() * lean.side;

    if let Some(mut transform) = camera.iter_mut().next() {
        *transform = player.camera_transform();
    }
}
