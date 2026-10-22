use bevy::prelude::Vec3;
use space_protocol::projection::WorldObject;

pub const PLATE_THICKNESS: f32 = 0.06;
pub const PLAYER_RADIUS: f32 = 0.3;
pub const HEAD_MARGIN: f32 = 0.2;
pub const CONTACT_SKIN: f32 = 0.01;
pub const GROUND_NORMAL_Y: f32 = 0.5;
const MAX_ITERATIONS: usize = 8;

#[derive(Debug, Clone, Copy)]
pub struct Collider {
    pub position: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub center: Vec3,
    pub half: Vec3,
}

#[derive(Debug, Clone, Copy)]
pub struct Contact {
    pub push: Vec3,
    pub normal: Vec3,
    pub depth: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Resolved {
    pub position: Vec3,
    pub grounded: bool,
    pub hit_ceiling: bool,
}

pub fn collider_for(object: &WorldObject) -> Option<Collider> {
    if object.base().held_by.is_some() {
        return None;
    }
    let base = object.base();
    let scale = if base.scale > 0.0 { base.scale } else { 1.0 };
    let (center, half) = match object {
        WorldObject::Box(o) => {
            let h = o.size * scale / 2.0;
            (Vec3::new(0.0, h, 0.0), Vec3::splat(h))
        }
        WorldObject::Image(o) => (
            Vec3::new(0.0, o.height * scale / 2.0, 0.0),
            Vec3::new(
                o.width * scale / 2.0,
                o.height * scale / 2.0,
                PLATE_THICKNESS * scale / 2.0,
            ),
        ),
        WorldObject::File(_) | WorldObject::Link(_) => (
            Vec3::new(0.0, space_protocol::FILE_ICON_HEIGHT * scale / 2.0, 0.0),
            Vec3::new(
                space_protocol::FILE_ICON_WIDTH * scale / 2.0,
                space_protocol::FILE_ICON_HEIGHT * scale / 2.0,
                PLATE_THICKNESS * scale / 2.0,
            ),
        ),
    };
    Some(Collider {
        position: Vec3::from(base.position),
        yaw: base.yaw,
        pitch: base.pitch,
        center,
        half,
    })
}

fn rotation(yaw: f32, pitch: f32) -> [Vec3; 3] {
    let (s, c) = yaw.sin_cos();
    let (sb, cb) = pitch.sin_cos();
    [
        Vec3::new(c, s * sb, s * cb),
        Vec3::new(0.0, cb, -sb),
        Vec3::new(-s, c * sb, c * cb),
    ]
}

pub fn sphere_vs_collider(center: Vec3, radius: f32, collider: Collider) -> Option<Contact> {
    let r = rotation(collider.yaw, collider.pitch);
    let d = center - collider.position;
    let local = Vec3::new(
        r[0].x * d.x + r[1].x * d.y + r[2].x * d.z - collider.center.x,
        r[0].y * d.x + r[1].y * d.y + r[2].y * d.z - collider.center.y,
        r[0].z * d.x + r[1].z * d.y + r[2].z * d.z - collider.center.z,
    );
    let closest = local.clamp(-collider.half, collider.half);
    let diff = local - closest;
    let distance = diff.length();

    let (normal_local, depth) = if distance > 1e-9 {
        if distance >= radius + CONTACT_SKIN {
            return None;
        }
        (diff / distance, radius - distance)
    } else {
        let mut axis = 0;
        let mut best = f32::INFINITY;
        for i in 0..3 {
            let penetration = collider.half[i] - local[i].abs();
            if penetration < best {
                best = penetration;
                axis = i;
            }
        }
        let mut normal = Vec3::ZERO;
        normal[axis] = if local[axis] >= 0.0 { 1.0 } else { -1.0 };
        (normal, best + radius)
    };

    let normal = Vec3::new(
        r[0].x * normal_local.x + r[0].y * normal_local.y + r[0].z * normal_local.z,
        r[1].x * normal_local.x + r[1].y * normal_local.y + r[1].z * normal_local.z,
        r[2].x * normal_local.x + r[2].y * normal_local.y + r[2].z * normal_local.z,
    );
    let amount = depth.max(0.0);
    Some(Contact {
        push: normal * amount,
        normal,
        depth,
    })
}

pub fn body_height_for(eye_height: f32) -> f32 {
    eye_height + HEAD_MARGIN
}

pub fn body_spheres(position: Vec3, height: f32) -> [Vec3; 3] {
    let feet = PLAYER_RADIUS;
    let head = (height - PLAYER_RADIUS).max(feet);
    [
        Vec3::new(position.x, position.y + feet, position.z),
        Vec3::new(position.x, position.y + (feet + head) / 2.0, position.z),
        Vec3::new(position.x, position.y + head, position.z),
    ]
}

pub fn resolve_player(position: Vec3, height: f32, colliders: &[Collider]) -> Resolved {
    let mut position = position;
    let mut grounded = false;
    let mut hit_ceiling = false;

    for _ in 0..MAX_ITERATIONS {
        let mut deepest: Option<Contact> = None;
        for sphere in body_spheres(position, height) {
            for collider in colliders {
                if let Some(contact) = sphere_vs_collider(sphere, PLAYER_RADIUS, *collider)
                    && deepest.is_none_or(|best| contact.depth > best.depth)
                {
                    deepest = Some(contact);
                }
            }
        }

        let Some(contact) = deepest else {
            break;
        };
        position += contact.push;
        if contact.normal.y > GROUND_NORMAL_Y {
            grounded = true;
        }
        if contact.normal.y < -GROUND_NORMAL_Y {
            hit_ceiling = true;
        }
    }

    Resolved {
        position,
        grounded,
        hit_ceiling,
    }
}

pub fn overlaps_any(position: Vec3, height: f32, colliders: &[Collider]) -> bool {
    body_spheres(position, height).iter().any(|sphere| {
        colliders
            .iter()
            .any(|collider| sphere_vs_collider(*sphere, PLAYER_RADIUS, *collider).is_some())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_collider(x: f32, y: f32, z: f32, size: f32) -> Collider {
        Collider {
            position: Vec3::new(x, y, z),
            yaw: 0.0,
            pitch: 0.0,
            center: Vec3::new(0.0, size / 2.0, 0.0),
            half: Vec3::splat(size / 2.0),
        }
    }

    #[test]
    fn standing_on_a_box_is_grounded() {
        let resolved = resolve_player(
            Vec3::new(0.0, 1.01, 0.0),
            body_height_for(1.6),
            &[box_collider(0.0, 0.0, 0.0, 1.0)],
        );
        assert!(resolved.grounded);
        assert!((resolved.position.y - 1.0).abs() < 0.02);
    }

    #[test]
    fn walking_into_a_box_pushes_out() {
        let resolved = resolve_player(
            Vec3::new(0.7, 0.0, 0.0),
            body_height_for(1.6),
            &[box_collider(0.0, 0.0, 0.0, 1.0)],
        );
        assert!(resolved.position.x > 0.79);
    }

    #[test]
    fn empty_space_keeps_position() {
        let position = Vec3::new(3.0, 0.0, 4.0);
        let resolved = resolve_player(position, body_height_for(1.6), &[]);
        assert_eq!(resolved.position, position);
        assert!(!resolved.grounded);
    }
}
