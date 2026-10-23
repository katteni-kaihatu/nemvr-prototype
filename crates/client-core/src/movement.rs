pub const EYE_HEIGHT: f32 = 1.6;
pub const CROUCH_EYE_HEIGHT: f32 = 0.9;
pub const CROUCH_SPEED_FACTOR: f32 = 0.5;
pub const SPRINT_SPEED_FACTOR: f32 = 2.0;
pub const SPRINT_BLOCKED_CROUCH: f32 = 0.5;
pub const GRAVITY: f32 = 20.0;
pub const JUMP_SPEED: f32 = 6.0;
pub const MAX_AIR_JUMPS: u8 = 1;
pub const LEAN_ANGLE: f32 = 0.3;
pub const WALK_SPEED: f32 = 3.0;
pub const WORLD_HALF_SIZE: f32 = 24.0;

const CROUCH_RATE: f32 = 14.0;
const JUMP_BLOCKED_CROUCH: f32 = 0.5;
const LEAN_RATE: f32 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vertical {
    pub y: f32,
    pub vy: f32,
    pub crouch: f32,
    pub grounded: bool,
    pub air_jumps: u8,
}

impl Default for Vertical {
    fn default() -> Self {
        Self {
            y: 0.0,
            vy: 0.0,
            crouch: 0.0,
            grounded: true,
            air_jumps: MAX_AIR_JUMPS,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct VerticalInput {
    pub jump: bool,
    pub jump_pressed: bool,
    pub crouch: bool,
}

pub fn eye_height_for(crouch: f32) -> f32 {
    let c = crouch.clamp(0.0, 1.0);
    EYE_HEIGHT + (CROUCH_EYE_HEIGHT - EYE_HEIGHT) * c
}

pub fn speed_factor_for(crouch: f32) -> f32 {
    let c = crouch.clamp(0.0, 1.0);
    1.0 - (1.0 - CROUCH_SPEED_FACTOR) * c
}

pub fn move_speed_factor(crouch: f32, sprinting: bool) -> f32 {
    let c = crouch.clamp(0.0, 1.0);
    let can_sprint = sprinting && c < SPRINT_BLOCKED_CROUCH;
    speed_factor_for(c) * if can_sprint { SPRINT_SPEED_FACTOR } else { 1.0 }
}

pub fn step_vertical(v: Vertical, input: VerticalInput, dt: f32) -> Vertical {
    let target = if input.crouch { 1.0 } else { 0.0 };
    let crouch = v.crouch + (target - v.crouch) * (1.0 - (-CROUCH_RATE * dt).exp());

    let mut vy = v.vy;
    let mut air_jumps = if v.grounded {
        MAX_AIR_JUMPS
    } else {
        v.air_jumps
    };
    let can_jump = v.crouch < JUMP_BLOCKED_CROUCH;
    if v.grounded && input.jump && can_jump {
        vy = JUMP_SPEED;
    } else if !v.grounded && input.jump_pressed && air_jumps > 0 && can_jump {
        vy = JUMP_SPEED;
        air_jumps -= 1;
    }

    vy -= GRAVITY * dt;
    let mut y = v.y + vy * dt;
    let mut grounded = false;
    if y <= 0.0 {
        y = 0.0;
        vy = 0.0;
        grounded = true;
    }

    Vertical {
        y,
        vy,
        crouch,
        grounded,
        air_jumps,
    }
}

pub fn step_lean(lean: f32, direction: f32, dt: f32) -> f32 {
    lean + (direction.clamp(-1.0, 1.0) - lean) * (1.0 - (-LEAN_RATE * dt).exp())
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LeanPose {
    pub side: f32,
    pub height: f32,
    pub roll: f32,
}

pub fn lean_pose(eye: f32, lean: f32) -> LeanPose {
    let roll = lean.clamp(-1.0, 1.0) * LEAN_ANGLE;
    LeanPose {
        side: eye * roll.sin(),
        height: eye * roll.cos(),
        roll,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 60.0;

    #[test]
    fn walking_speed_factors_match_web() {
        assert_eq!(move_speed_factor(0.0, false), 1.0);
        assert_eq!(move_speed_factor(0.0, true), 2.0);
        assert_eq!(move_speed_factor(1.0, true), 0.5);
        assert_eq!(move_speed_factor(0.5, true), 0.75);
    }

    #[test]
    fn double_jump_is_available_once() {
        let mut v = Vertical::default();
        v = step_vertical(
            v,
            VerticalInput {
                jump: true,
                jump_pressed: true,
                crouch: false,
            },
            DT,
        );
        assert!(v.vy > 0.0);
        for _ in 0..10 {
            v = step_vertical(v, VerticalInput::default(), DT);
        }
        v = step_vertical(
            v,
            VerticalInput {
                jump: true,
                jump_pressed: true,
                crouch: false,
            },
            DT,
        );
        assert!(v.vy > 0.0);
        assert_eq!(v.air_jumps, 0);
    }

    #[test]
    fn crouch_lowers_eye_height() {
        assert!((eye_height_for(1.0) - 0.9).abs() < f32::EPSILON);
        assert!((eye_height_for(0.5) - 1.25).abs() < 0.001);
    }

    #[test]
    fn lean_pose_keeps_eye_distance() {
        let pose = lean_pose(1.6, 1.0);
        let distance = (pose.side * pose.side + pose.height * pose.height).sqrt();
        assert!((distance - 1.6).abs() < 0.001);
        assert!(pose.roll > 0.0);
    }
}
