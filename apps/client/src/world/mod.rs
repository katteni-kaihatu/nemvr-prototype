use bevy::prelude::*;

pub mod avatars;
pub mod carry;
pub mod collision;
pub mod interaction;
pub mod movement;
pub mod objects;
pub mod player;
pub mod scene;

pub use movement::Vertical;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrabMode {
    Move,
    Rotate,
}

#[derive(Debug, Clone)]
pub struct GrabState {
    pub id: String,
    pub attachment: carry::Attachment,
    pub mode: GrabMode,
    pub start_pitch: f32,
    pub start_eye: f32,
    pub scale: f32,
}

#[derive(Resource)]
pub struct LocalPlayer {
    pub position: Vec3,
    pub vertical: Vertical,
    pub yaw: f32,
    pub pitch: f32,
    pub lean: f32,
    pub eye_y: f32,
    pub head_x: f32,
    pub head_z: f32,
    pub pending_jump: bool,
    pub hovered_id: Option<String>,
    pub grabbed_id: Option<String>,
    pub grab: Option<GrabState>,
    pub grab_command: Option<String>,
}

impl Default for LocalPlayer {
    fn default() -> Self {
        Self {
            position: Vec3::new(0.0, 0.0, 4.0),
            vertical: Vertical::default(),
            yaw: 0.0,
            pitch: 0.0,
            lean: 0.0,
            eye_y: movement::EYE_HEIGHT,
            head_x: 0.0,
            head_z: 4.0,
            pending_jump: false,
            hovered_id: None,
            grabbed_id: None,
            grab: None,
            grab_command: None,
        }
    }
}

impl LocalPlayer {
    pub fn position(&self) -> [f64; 3] {
        [
            self.position.x as f64,
            self.position.y as f64,
            self.position.z as f64,
        ]
    }

    pub fn crouch(&self) -> f32 {
        self.vertical.crouch
    }

    pub fn lean(&self) -> f32 {
        self.lean
    }

    pub fn eye_height(&self) -> f32 {
        movement::eye_height_for(self.vertical.crouch)
    }

    pub fn head_quat(&self) -> [f64; 4] {
        let quat = self.rotation();
        [quat.x as f64, quat.y as f64, quat.z as f64, quat.w as f64]
    }

    pub fn rotation(&self) -> Quat {
        Quat::from_euler(
            EulerRot::YXZ,
            self.yaw,
            self.pitch,
            -movement::lean_pose(self.eye_height(), self.lean).roll,
        )
    }

    pub fn camera_transform(&self) -> Transform {
        Transform::from_xyz(self.head_x, self.eye_y, self.head_z).with_rotation(self.rotation())
    }

    pub fn release_local(&mut self) {
        self.grabbed_id = None;
        self.grab = None;
        self.grab_command = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RingAction {
    Delete,
    Duplicate,
    Download,
    Close,
}

#[derive(Resource, Default)]
pub struct RingMenu {
    pub target: Option<String>,
}

pub struct WorldPlugin;

impl Plugin for WorldPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<LocalPlayer>()
            .init_resource::<RingMenu>()
            .init_resource::<avatars::PeerVisuals>()
            .add_systems(Startup, (scene::setup_scene, objects::setup_assets))
            .add_systems(
                Update,
                (
                    scene::draw_grid,
                    player::lock_cursor,
                    player::update_player,
                    avatars::sync_avatars,
                    objects::sync_objects,
                    objects::load_images,
                    interaction::update_interaction,
                    interaction::handle_drops,
                    interaction::open_ring_menu,
                    interaction::keyboard_actions,
                )
                    .chain()
                    .run_if(in_state(crate::AppState::InWorld)),
            )
            .add_systems(Update, interaction::handle_avatar_drop);
    }
}
