#![allow(clippy::too_many_arguments, clippy::type_complexity)]

mod config;
mod content;
mod headless;
mod net;
mod ui;
#[cfg(feature = "vrm")]
mod vrm;
mod world;

const UI_FONT: &[u8] = include_bytes!("../../../assets/fonts/migu-1m-regular.ttf");

use bevy::audio::AudioPlugin;
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};
use bevy::text::Font;
use clap::Parser;

use crate::config::ClientConfig;
use crate::content::ContentService;
use crate::net::client::NetHandle;
use crate::net::{
    ContentCache, NetPlugin, NetState, PendingPlacements, connect_options, store::SpaceStore,
};
use crate::ui::UiPlugin;
use crate::world::WorldPlugin;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, States)]
pub enum AppState {
    #[default]
    Lobby,
    Connecting,
    InWorld,
}

#[derive(Debug, Parser)]
#[command(
    name = "proto-client",
    about = "Native Bevy client for the VR SNS prototype"
)]
struct Args {
    /// WebSocket URL (ws://host:port/ws)
    #[arg(long)]
    server: Option<String>,
    /// Display name. When provided, connect immediately.
    #[arg(long)]
    name: Option<String>,
    /// Run without Bevy: join, print messages, and exit.
    #[arg(long)]
    headless: bool,
    /// Headless scenario: join, then place a box and keep the connection open.
    #[arg(long, default_value = "join")]
    scenario: String,
    /// Headless duration in seconds.
    #[arg(long, default_value_t = 5)]
    duration: u64,
    /// VRM avatar file to upload on join.
    #[arg(long)]
    avatar: Option<std::path::PathBuf>,
    /// Show the self-view mirror at startup.
    #[arg(long)]
    mirror: bool,
    /// Save a screenshot of the world after startup (for E2E checks).
    #[arg(long)]
    screenshot: Option<std::path::PathBuf>,
    /// Start the embedded IPFS node, print its peer ID, and exit.
    #[arg(long)]
    ipfs_smoke: bool,
}

fn main() {
    let args = Args::parse();
    let mut config = ClientConfig::load();
    if let Some(server) = &args.server {
        config.server = server.clone();
    }
    if let Some(name) = &args.name {
        config.name = name.clone();
    }
    if let Some(avatar) = &args.avatar {
        config.avatar_path = Some(avatar.clone());
    }

    if args.headless {
        headless::run(
            config.server.clone(),
            config.name.clone(),
            args.scenario,
            args.duration,
        );
        return;
    }

    if args.ipfs_smoke {
        headless::ipfs_smoke();
        return;
    }

    let initial = args
        .name
        .as_ref()
        .map(|name| connect_options(&config.server, name));
    let net = NetHandle::spawn(initial);
    let content = ContentService::spawn(config.http_base());

    let asset_root = config::project_dirs()
        .map(|dirs| dirs.cache_dir().join("assets"))
        .unwrap_or_else(|| std::path::PathBuf::from("assets"));
    std::fs::create_dir_all(asset_root.join("vrm")).ok();
    let asset_root = asset_root.to_string_lossy().replace('\\', "/");

    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(AssetPlugin {
                file_path: asset_root,
                ..default()
            })
            .set(LogPlugin {
                filter: "wgpu=error,naga=warn,icu_provider=off".into(),
                ..default()
            })
            .set(WindowPlugin {
                primary_window: Some(Window {
                    title: "Proto SNS".into(),
                    resolution: (1280u32, 720u32).into(),
                    ..default()
                }),
                ..default()
            })
            // 音声はまだ使っていない。音声デバイスが無い環境でも起動できるようにする。
            .disable::<AudioPlugin>(),
    )
    .insert_resource(config.clone())
    .insert_resource(NetState {
        name: config.name.clone(),
        server: config.server.clone(),
        ..default()
    })
    .insert_resource(SpaceStore::default())
    .insert_resource(ContentCache::default())
    .insert_resource(PendingPlacements::default())
    .insert_resource(net)
    .insert_resource(content)
    .init_state::<AppState>()
    .add_systems(Startup, install_ui_font)
    .add_plugins((
        bevy::input_focus::tab_navigation::TabNavigationPlugin,
        NetPlugin,
        WorldPlugin,
        UiPlugin,
    ));
    #[cfg(feature = "vrm")]
    app.add_plugins((bevy_vrm::VrmPlugins, vrm::VrmPlugin));
    app.insert_resource(crate::world::mirror::MirrorState {
        enabled: args.mirror,
    });
    if let Some(path) = args.screenshot.clone() {
        app.insert_resource(ScreenshotRequest { path, frames: 0 })
            .add_systems(Update, take_screenshot);
    }

    if args.name.is_some() {
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::Connecting);
    }

    app.run();
}

fn install_ui_font(mut fonts: ResMut<Assets<Font>>) {
    let _ = fonts.insert(
        Handle::<Font>::default().id(),
        Font::from_bytes(UI_FONT.to_vec()),
    );
}

#[derive(Resource)]
struct ScreenshotRequest {
    path: std::path::PathBuf,
    frames: u32,
}

fn take_screenshot(
    mut commands: Commands,
    mut request: ResMut<ScreenshotRequest>,
    state: Res<State<AppState>>,
) {
    if *state.get() != AppState::InWorld {
        return;
    }
    request.frames += 1;
    if request.frames == 90 {
        commands
            .spawn(Screenshot::primary_window())
            .observe(save_to_disk(request.path.clone()));
        bevy::log::info!("screenshot requested: {}", request.path.display());
    }
}
