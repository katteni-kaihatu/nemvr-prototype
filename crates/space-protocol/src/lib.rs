//! space v2 のワイヤ型、共有スキーマ、描画用の写像。
//!
//! サーバー (Elixir) と Web クライアント (`packages/protocol`) が正であり、
//! この crate はネイティブクライアント用の忠実な移植。

pub mod messages;
pub mod projection;
pub mod schema;

pub use messages::*;
pub use projection::*;
pub use schema::*;

pub const SPACE_PROTOCOL_VERSION: u32 = 2;
pub const SPACE_SCHEMA_VERSION: u32 = 1;
pub const SPACE_TEMPLATE_ID: &str = "vr-sns-3d";
pub const DEFAULT_SESSION_ID: &str = "main";
pub const SPACE_TICK_RATE: u32 = 20;
pub const SPACE_TICK_INTERVAL_MS: f64 = 1000.0 / SPACE_TICK_RATE as f64;

pub const MAX_NAME_LENGTH: usize = 24;
pub const MAX_MESSAGE_BYTES: usize = 4096;
pub const MAX_URL_LENGTH: usize = 2048;
pub const MAX_ABS_POSITION: f32 = 1000.0;

pub const MAX_IMAGE_BYTES: u64 = 24 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_AVATAR_BYTES: u64 = 64 * 1024 * 1024;
pub const EAGER_FILE_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_OBJECTS: usize = 100;
pub const MIN_OBJECT_SIZE: f32 = 0.1;
pub const MAX_OBJECT_SIZE: f32 = 20.0;
pub const MIN_OBJECT_SCALE: f32 = 0.1;
pub const MAX_OBJECT_SCALE: f32 = 10.0;

/// ファイル / リンクのアイコン (板) の大きさ。
pub const FILE_ICON_WIDTH: f32 = 0.9;
pub const FILE_ICON_HEIGHT: f32 = 1.2;
pub const FILE_FLOAT_HEIGHT: f32 = 0.6;

/// 補間のために描画を遅らせる時間 (2 tick 分)。
pub const INTERPOLATION_DELAY_MS: f64 = 100.0;
