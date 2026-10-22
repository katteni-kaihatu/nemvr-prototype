use bevy::input::mouse::MouseWheel;
use bevy::prelude::*;
use bevy::window::FileDragAndDrop;
use serde_json::json;
use space_protocol::messages::{ClientMessage, SpaceMutation};
use space_protocol::projection::WorldObject;
use uuid::Uuid;

use crate::content::ContentService;
use crate::net::client::NetHandle;
use crate::net::{NetState, PendingPlacements, Placement, send_claim, send_patch, send_release};
use crate::world::carry::{attach, lifted_height, pulled, scaled};
use crate::world::objects::ObjectVisual;
use crate::world::scene::MainCamera;
use crate::world::{GrabMode, GrabState, LocalPlayer, RingMenu};

const MAX_PLACE_DISTANCE: f32 = 20.0;
const FALLBACK_DISTANCE: f32 = 4.0;
const IMAGE_GAP: f32 = 0.3;
const MAX_HEIGHT: f32 = 20.0;

pub fn update_interaction(
    time: Res<Time>,
    mouse: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    mut wheels: MessageReader<MouseWheel>,
    camera: Query<&Transform, With<MainCamera>>,
    mut state: ResMut<NetState>,
    net: Res<NetHandle>,
    mut player: ResMut<LocalPlayer>,
    mut menu: ResMut<RingMenu>,
    mut grab_timer: Local<f32>,
    mut visuals: Query<(&ObjectVisual, &mut Transform), Without<MainCamera>>,
) {
    let Some(camera) = camera.iter().next() else {
        return;
    };
    let origin = camera.translation;
    let direction = camera.rotation * Vec3::NEG_Z;

    player.hovered_id = pick_object(origin, direction, &state);
    if let Some(cid) = state.last_rejected_command.clone()
        && player.grab_command.as_deref() == Some(cid.as_str())
    {
        player.release_local();
        menu.target = None;
    }
    if state.last_rejected_command.is_some() && player.grab_command.is_none() {
        state.last_rejected_command = None;
    }

    if mouse.just_pressed(MouseButton::Right)
        && menu.target.is_none()
        && let Some(id) = player.hovered_id.clone()
        && let Some(object) = state.projected.objects.get(&id)
    {
        let camera_state = crate::world::carry::CameraState {
            x: player.head_x,
            z: player.head_z,
            yaw: player.yaw,
        };
        let object_state = crate::world::carry::ObjectState {
            x: object.base().position[0],
            y: object.base().position[1],
            z: object.base().position[2],
            yaw: object.base().yaw,
        };
        player.grab_command = Some(send_claim(net.as_ref(), &id));
        player.grabbed_id = Some(id.clone());
        player.grab = Some(GrabState {
            id,
            attachment: attach(camera_state, object_state),
            mode: GrabMode::Move,
            start_pitch: player.pitch,
            start_eye: player.eye_height(),
            scale: object.base().scale.max(0.01),
        });
    }

    if mouse.just_released(MouseButton::Right)
        && let Some(id) = player.grabbed_id.clone()
    {
        send_release(net.as_ref(), &id);
        player.release_local();
    }

    let eye_height = player.eye_height();
    let pitch = player.pitch;
    let head_x = player.head_x;
    let head_z = player.head_z;
    let yaw = player.yaw;

    let Some(grab) = player.grab.as_mut() else {
        wheels.clear();
        return;
    };

    if keys.just_pressed(KeyCode::KeyE) {
        grab.mode = match grab.mode {
            GrabMode::Move => GrabMode::Rotate,
            GrabMode::Rotate => GrabMode::Move,
        };
    }

    let mut wheel = 0.0;
    for event in wheels.read() {
        wheel += event.y;
    }

    if grab.mode == GrabMode::Rotate {
        grab.attachment.dyaw -= wheel * 0.12;
    } else if keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight) {
        grab.scale = scaled(grab.scale, 1.12_f32.powf(wheel));
    } else if wheel != 0.0 {
        grab.attachment = pulled(
            grab.attachment,
            1.08_f32.powf(wheel),
            eye_height,
            MAX_HEIGHT,
        );
    }

    let distance =
        (grab.attachment.dx * grab.attachment.dx + grab.attachment.dz * grab.attachment.dz).sqrt();
    grab.attachment.y = lifted_height(
        grab.attachment.y,
        distance,
        pitch - grab.start_pitch,
        grab.start_eye,
        MAX_HEIGHT,
    );

    let camera_state = crate::world::carry::CameraState {
        x: head_x,
        z: head_z,
        yaw,
    };
    let resolved = crate::world::carry::resolve(grab.attachment, camera_state);
    for (visual, mut transform) in &mut visuals {
        if visual.id == grab.id {
            *transform = Transform {
                translation: Vec3::new(resolved.x, resolved.y, resolved.z),
                rotation: Quat::from_rotation_y(resolved.yaw),
                scale: Vec3::splat(grab.scale),
            };
        }
    }

    *grab_timer += time.delta_secs();
    if *grab_timer >= 0.05 {
        *grab_timer = 0.0;
        send_patch(
            net.as_ref(),
            &grab.id,
            json!({
                "space.position": [resolved.x, resolved.y, resolved.z],
                "space.yaw": resolved.yaw,
                "space.pitch": 0.0,
                "space.scale": grab.scale,
            }),
        );
    }
}

fn pick_object(origin: Vec3, direction: Vec3, state: &NetState) -> Option<String> {
    let mut best: Option<(f32, String)> = None;
    for (id, object) in &state.projected.objects {
        let base = object.base();
        let center = Vec3::new(
            base.position[0],
            base.position[1] + object_height(object) * 0.5,
            base.position[2],
        );
        let radius = object_radius(object);
        let to_center = center - origin;
        let along = to_center.dot(direction);
        if along <= 0.0 {
            continue;
        }
        let closest = origin + direction * along;
        if (closest - center).length() <= radius
            && best
                .as_ref()
                .is_none_or(|(best_along, _)| along < *best_along)
        {
            best = Some((along, id.clone()));
        }
    }
    best.map(|(_, id)| id)
}

fn object_height(object: &WorldObject) -> f32 {
    match object {
        WorldObject::Box(o) => o.size * o.base.scale,
        WorldObject::Image(o) => o.height * o.base.scale,
        WorldObject::File(_) | WorldObject::Link(_) => {
            space_protocol::FILE_ICON_HEIGHT * object.base().scale
        }
    }
}

fn object_radius(object: &WorldObject) -> f32 {
    let base = object.base().scale.max(0.01);
    match object {
        WorldObject::Box(o) => o.size * base * 0.75,
        WorldObject::Image(o) => o.width.max(o.height) * base * 0.6,
        WorldObject::File(_) | WorldObject::Link(_) => 0.7 * base,
    }
}

pub fn handle_drops(
    mut events: MessageReader<FileDragAndDrop>,
    content: Res<ContentService>,
    camera: Query<&Transform, With<MainCamera>>,
    player: Res<LocalPlayer>,
    mut pending: ResMut<PendingPlacements>,
    mut slot: Local<usize>,
) {
    let Some(camera) = camera.iter().next() else {
        return;
    };
    for event in events.read() {
        let FileDragAndDrop::DroppedFile { path_buf, .. } = event else {
            continue;
        };
        let point = drop_point(camera);
        let yaw = (player.head_x - point.x).atan2(player.head_z - point.z);
        let right = Vec3::new(yaw.cos(), 0.0, -yaw.sin());
        let index = *slot;
        let offset = (index as f32 - 1.5) * IMAGE_GAP;
        let position = point + right * offset;
        *slot = (*slot + 1) % 8;

        pending.by_path.insert(
            path_buf.clone(),
            Placement {
                position: [position.x as f64, 0.0, position.z as f64],
                yaw: yaw as f64,
            },
        );
        content.add_file(path_buf.clone());
    }
}

fn drop_point(camera: &Transform) -> Vec3 {
    let origin = camera.translation;
    let direction = camera.rotation * Vec3::NEG_Z;
    let mut point = if direction.y.abs() > 1e-4 {
        let t = -origin.y / direction.y;
        if t > 0.0 && t <= MAX_PLACE_DISTANCE {
            origin + direction * t
        } else {
            fallback_point(origin, direction)
        }
    } else {
        fallback_point(origin, direction)
    };
    point.y = 0.0;
    point.x = point.x.clamp(-24.0, 24.0);
    point.z = point.z.clamp(-24.0, 24.0);
    point
}

fn fallback_point(origin: Vec3, direction: Vec3) -> Vec3 {
    let mut flat = Vec3::new(direction.x, 0.0, direction.z);
    if flat.length_squared() < 1e-6 {
        flat = Vec3::NEG_Z;
    }
    origin + flat.normalize() * FALLBACK_DISTANCE
}

pub fn open_ring_menu(
    mouse: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    player: Res<LocalPlayer>,
    mut menu: ResMut<RingMenu>,
) {
    if (mouse.just_pressed(MouseButton::Middle) || keys.just_pressed(KeyCode::KeyM))
        && let Some(id) = player.hovered_id.clone()
    {
        menu.target = Some(id);
    }
    if keys.just_pressed(KeyCode::Escape) {
        menu.target = None;
    }
}

pub fn keyboard_actions(
    keys: Res<ButtonInput<KeyCode>>,
    net: Res<NetHandle>,
    player: Res<LocalPlayer>,
    camera: Query<&Transform, With<MainCamera>>,
    mut menu: ResMut<RingMenu>,
) {
    if keys.just_pressed(KeyCode::KeyB)
        && let Some(camera) = camera.iter().next()
    {
        let point = drop_point(camera);
        let yaw = (player.head_x - point.x).atan2(player.head_z - point.z);
        let entity_id = Uuid::new_v4().to_string();
        let dimensions = json!({
            "entity.kind": "box",
            "space.position": [point.x, 0.0, point.z],
            "space.yaw": yaw,
            "box.size": 1.0,
            "box.color": "#4a5a4a",
        });
        if let Some(dimensions) = dimensions.as_object() {
            let mutation = SpaceMutation::Create {
                command_id: Uuid::new_v4().to_string(),
                entity_id,
                dimensions: dimensions.clone(),
            };
            let _ = net.send(ClientMessage::SpaceMutate { mutation });
        }
    }

    if keys.just_pressed(KeyCode::KeyF) {
        menu.target = None;
    }
}
