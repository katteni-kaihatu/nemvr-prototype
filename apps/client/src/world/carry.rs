use space_protocol::{MAX_OBJECT_SCALE, MIN_OBJECT_SCALE};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraState {
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ObjectState {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Attachment {
    pub dx: f32,
    pub dz: f32,
    pub y: f32,
    pub dyaw: f32,
}

pub const MIN_LIFT_DISTANCE: f32 = 0.5;
pub const MAX_AIM: f32 = 1.5;
pub const MIN_PULL_DISTANCE: f32 = 1.0;
pub const MAX_PULL_DISTANCE: f32 = 30.0;

pub fn attach(camera: CameraState, object: ObjectState) -> Attachment {
    let wx = object.x - camera.x;
    let wz = object.z - camera.z;
    let (sin, cos) = camera.yaw.sin_cos();
    Attachment {
        dx: wx * cos - wz * sin,
        dz: wx * sin + wz * cos,
        y: object.y,
        dyaw: object.yaw - camera.yaw,
    }
}

pub fn resolve(attachment: Attachment, camera: CameraState) -> ObjectState {
    let (sin, cos) = camera.yaw.sin_cos();
    ObjectState {
        x: camera.x + attachment.dx * cos + attachment.dz * sin,
        y: attachment.y,
        z: camera.z - attachment.dx * sin + attachment.dz * cos,
        yaw: camera.yaw + attachment.dyaw,
    }
}

pub fn lifted_height(y: f32, distance: f32, d_pitch: f32, eye_height: f32, max_height: f32) -> f32 {
    let d = distance.max(MIN_LIFT_DISTANCE);
    let aim = ((y - eye_height).atan2(d) + d_pitch).clamp(-MAX_AIM, MAX_AIM);
    (eye_height + d * aim.tan()).clamp(0.0, max_height)
}

pub fn scaled(current: f32, factor: f32) -> f32 {
    let base = if current.is_finite() && current > 0.0 {
        current
    } else {
        1.0
    };
    (base * factor).clamp(MIN_OBJECT_SCALE, MAX_OBJECT_SCALE)
}

pub fn pulled(attachment: Attachment, factor: f32, eye_height: f32, max_height: f32) -> Attachment {
    let old = (attachment.dx * attachment.dx + attachment.dz * attachment.dz).sqrt();
    let (dir_x, dir_z) = if old > 1e-6 {
        (attachment.dx / old, attachment.dz / old)
    } else {
        (0.0, -1.0)
    };
    let scaled = if old > 1e-6 {
        old * factor
    } else if factor > 1.0 {
        MIN_PULL_DISTANCE
    } else {
        0.0
    };
    let next = old
        .min(MIN_PULL_DISTANCE)
        .max(scaled.min(MAX_PULL_DISTANCE.max(old)));
    let aim = (attachment.y - eye_height).atan2(old.max(1e-6));
    let y = (eye_height + next * aim.tan()).clamp(0.0, max_height);
    Attachment {
        dx: dir_x * next,
        dz: dir_z * next,
        y,
        dyaw: attachment.dyaw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_and_resolve_round_trip() {
        let camera = CameraState {
            x: 2.0,
            z: -3.0,
            yaw: 0.7,
        };
        let object = ObjectState {
            x: 4.0,
            y: 1.0,
            z: 1.0,
            yaw: 1.2,
        };
        let resolved = resolve(attach(camera, object), camera);
        assert!((resolved.x - object.x).abs() < 1e-5);
        assert!((resolved.y - object.y).abs() < 1e-5);
        assert!((resolved.z - object.z).abs() < 1e-5);
        assert!((resolved.yaw - object.yaw).abs() < 1e-5);
    }

    #[test]
    fn lifting_clamps_to_floor_and_ceiling() {
        assert_eq!(lifted_height(0.0, 2.0, -10.0, 1.6, 5.0), 0.0);
        assert_eq!(lifted_height(0.0, 2.0, 10.0, 1.6, 5.0), 5.0);
    }

    #[test]
    fn scaling_clamps() {
        assert_eq!(scaled(1.0, 100.0), MAX_OBJECT_SCALE);
        assert_eq!(scaled(1.0, 0.001), MIN_OBJECT_SCALE);
        assert_eq!(scaled(f32::NAN, 2.0), 2.0);
    }

    #[test]
    fn pulling_keeps_the_aim_direction() {
        let attachment = Attachment {
            dx: 2.0,
            dz: 0.0,
            y: 1.6,
            dyaw: 0.0,
        };
        let pulled = pulled(attachment, 2.0, 1.6, 10.0);
        assert!((pulled.dx - 4.0).abs() < 1e-4);
        assert!((pulled.dz).abs() < 1e-4);
    }
}
