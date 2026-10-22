use bevy::input::keyboard::Key;
use bevy::input_focus::AutoFocus;
use bevy::prelude::*;
use bevy::text::{EditableText, TextCursorStyle};

use crate::AppState;
use crate::config::ClientConfig;
use crate::net::client::NetHandle;
use crate::net::{NetState, NetStatus, connect_options};
use crate::world::{LocalPlayer, RingAction, RingMenu};

#[derive(Component)]
pub struct LobbyUi;

#[derive(Component)]
pub struct HudUi;

#[derive(Component)]
pub struct HudText;

#[derive(Component)]
pub struct NameInput;

#[derive(Component)]
pub struct ServerInput;

#[derive(Component)]
pub struct LobbyStatus;

#[derive(Component)]
pub struct ConnectButton;

#[derive(Component)]
pub struct RingUi;

#[derive(Component)]
pub struct RingButton(pub RingAction);

pub fn spawn_ui(mut commands: Commands, config: Res<ClientConfig>) {
    spawn_lobby(&mut commands, &config);
    spawn_hud(&mut commands);
    spawn_ring_menu(&mut commands);
}

fn spawn_lobby(commands: &mut Commands, config: &ClientConfig) {
    commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                width: percent(100.0),
                height: percent(100.0),
                align_items: AlignItems::Center,
                justify_content: JustifyContent::Center,
                ..default()
            },
            BackgroundColor(Color::srgba(0.04, 0.05, 0.07, 0.92)),
            LobbyUi,
        ))
        .with_children(|root| {
            root.spawn((
                Node {
                    width: px(440),
                    flex_direction: FlexDirection::Column,
                    row_gap: px(14),
                    padding: px(28).all(),
                    border: px(1).all(),
                    ..default()
                },
                BackgroundColor(Color::srgb(0.08, 0.10, 0.13)),
                BorderColor::all(Color::srgb(0.25, 0.30, 0.36)),
            ))
            .with_children(|panel| {
                panel.spawn((
                    Text::new("Proto SNS"),
                    TextFont {
                        font_size: FontSize::Px(32.0),
                        ..default()
                    },
                    TextColor(Color::WHITE),
                ));
                panel.spawn((
                    Text::new("表示名を入力して接続します。"),
                    TextFont {
                        font_size: FontSize::Px(14.0),
                        ..default()
                    },
                    TextColor(Color::srgb(0.7, 0.75, 0.8)),
                ));
                panel.spawn((
                    Node {
                        width: percent(100.0),
                        padding: px(10).all(),
                        border: px(1).all(),
                        margin: px(4).top(),
                        ..default()
                    },
                    BorderColor::all(Color::srgb(0.3, 0.4, 0.5)),
                    BackgroundColor(Color::srgb(0.06, 0.07, 0.09)),
                    EditableText::new(config.name.clone()),
                    TextLayout::no_wrap(),
                    TextFont {
                        font_size: FontSize::Px(20.0),
                        ..default()
                    },
                    TextCursorStyle::default(),
                    NameInput,
                    AutoFocus,
                ));
                panel.spawn((
                    Text::new("サーバー"),
                    TextFont {
                        font_size: FontSize::Px(12.0),
                        ..default()
                    },
                    TextColor(Color::srgb(0.65, 0.7, 0.75)),
                ));
                panel.spawn((
                    Node {
                        width: percent(100.0),
                        padding: px(7).all(),
                        border: px(1).all(),
                        ..default()
                    },
                    BorderColor::all(Color::srgb(0.25, 0.32, 0.4)),
                    BackgroundColor(Color::srgb(0.06, 0.07, 0.09)),
                    EditableText::new(config.server.clone()),
                    TextLayout::no_wrap(),
                    TextFont {
                        font_size: FontSize::Px(13.0),
                        ..default()
                    },
                    TextCursorStyle::default(),
                    ServerInput,
                ));
                panel
                    .spawn((
                        Button,
                        Node {
                            width: percent(100.0),
                            padding: px(12).all(),
                            justify_content: JustifyContent::Center,
                            margin: px(6).top(),
                            ..default()
                        },
                        BackgroundColor(Color::srgb(0.18, 0.45, 0.34)),
                        ConnectButton,
                    ))
                    .with_children(|button| {
                        button.spawn((
                            Text::new("接続"),
                            TextFont {
                                font_size: FontSize::Px(20.0),
                                ..default()
                            },
                            TextColor(Color::WHITE),
                        ));
                    });
                panel.spawn((
                    Text::new(format!("接続先: {}", config.server)),
                    TextFont {
                        font_size: FontSize::Px(12.0),
                        ..default()
                    },
                    TextColor(Color::srgb(0.65, 0.78, 0.7)),
                    LobbyStatus,
                ));
                panel.spawn((
                    Text::new("Enter でも接続できます。"),
                    TextFont {
                        font_size: FontSize::Px(12.0),
                        ..default()
                    },
                    TextColor(Color::srgb(0.55, 0.6, 0.66)),
                ));
            });
        });
}

fn spawn_hud(commands: &mut Commands) {
    commands.spawn((
        Node {
            position_type: PositionType::Absolute,
            left: px(14),
            top: px(14),
            width: px(360),
            padding: px(12).all(),
            flex_direction: FlexDirection::Column,
            row_gap: px(4),
            ..default()
        },
        BackgroundColor(Color::srgba(0.02, 0.03, 0.04, 0.72)),
        Visibility::Hidden,
        HudUi,
        Text::new(""),
        TextFont {
            font_size: FontSize::Px(13.0),
            ..default()
        },
        TextColor(Color::srgb(0.86, 0.9, 0.94)),
        HudText,
    ));
}

fn spawn_ring_menu(commands: &mut Commands) {
    commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                left: percent(50.0),
                top: percent(50.0),
                margin: UiRect::new(px(20), px(0), px(-40), px(0)),
                flex_direction: FlexDirection::Column,
                row_gap: px(6),
                padding: px(10).all(),
                ..default()
            },
            BackgroundColor(Color::srgba(0.02, 0.03, 0.04, 0.9)),
            Visibility::Hidden,
            RingUi,
        ))
        .with_children(|menu| {
            for (action, label) in [
                (RingAction::Delete, "削除"),
                (RingAction::Duplicate, "複製"),
                (RingAction::Download, "ダウンロード"),
                (RingAction::Close, "閉じる"),
            ] {
                menu.spawn((
                    Button,
                    Node {
                        width: px(170),
                        padding: px(8).all(),
                        justify_content: JustifyContent::Center,
                        ..default()
                    },
                    BackgroundColor(Color::srgb(0.12, 0.16, 0.2)),
                    RingButton(action),
                ))
                .with_children(|button| {
                    button.spawn((
                        Text::new(label),
                        TextFont {
                            font_size: FontSize::Px(15.0),
                            ..default()
                        },
                        TextColor(Color::WHITE),
                    ));
                });
            }
        });
}

pub fn sync_visibility(
    state: Res<State<AppState>>,
    mut lobby: Query<&mut Visibility, (With<LobbyUi>, Without<HudUi>, Without<RingUi>)>,
    mut hud: Query<&mut Visibility, (With<HudUi>, Without<LobbyUi>, Without<RingUi>)>,
    mut ring: Query<&mut Visibility, (With<RingUi>, Without<LobbyUi>, Without<HudUi>)>,
    menu: Res<RingMenu>,
) {
    let in_world = *state.get() == AppState::InWorld;
    for mut visibility in &mut lobby {
        *visibility = if in_world {
            Visibility::Hidden
        } else {
            Visibility::Visible
        };
    }
    for mut visibility in &mut hud {
        *visibility = if in_world {
            Visibility::Visible
        } else {
            Visibility::Hidden
        };
    }
    for mut visibility in &mut ring {
        *visibility = if in_world && menu.target.is_some() {
            Visibility::Visible
        } else {
            Visibility::Hidden
        };
    }
}

pub fn lobby_actions(
    state: Res<State<AppState>>,
    net: ResMut<NetHandle>,
    mut config: ResMut<ClientConfig>,
    mut next_state: ResMut<NextState<AppState>>,
    mut net_state: ResMut<NetState>,
    keyboard: Res<ButtonInput<Key>>,
    buttons: Query<&Interaction, With<ConnectButton>>,
    names: Query<&EditableText, With<NameInput>>,
    servers: Query<&EditableText, With<ServerInput>>,
    mut was_pressed: Local<bool>,
) {
    if *state.get() == AppState::InWorld {
        return;
    }

    let pressed = buttons
        .iter()
        .any(|interaction| *interaction == Interaction::Pressed);
    let trigger = (pressed && !*was_pressed) || keyboard.just_pressed(Key::Enter);
    *was_pressed = pressed;
    if !trigger {
        return;
    }

    let mut name = names
        .iter()
        .next()
        .map(|input| format!("{}", input.value()))
        .unwrap_or_default();
    name = name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(space_protocol::MAX_NAME_LENGTH)
        .collect();
    if name.is_empty() {
        name = "Guest".into();
    }

    let mut server = servers
        .iter()
        .next()
        .map(|input| format!("{}", input.value()))
        .unwrap_or_else(|| config.server.clone());
    server = server.trim().to_owned();
    if server.is_empty() {
        server = config.server.clone();
    }

    config.name = name.clone();
    config.server = server.clone();
    config.save();
    net_state.name = name.clone();
    net_state.server = server.clone();
    net_state.status = NetStatus::Connecting;
    net_state.log(format!("{name} として {server} へ接続します"));
    net.connect(connect_options(&server, &name));
    next_state.set(AppState::Connecting);
}

pub fn update_lobby_status(state: Res<NetState>, mut text: Query<&mut Text, With<LobbyStatus>>) {
    let Some(mut text) = text.iter_mut().next() else {
        return;
    };
    text.0 = match state.status {
        NetStatus::Idle => format!("接続先: {}", state.server),
        NetStatus::Connecting => format!("接続中: {}", state.server),
        NetStatus::Online => "接続しました".into(),
        NetStatus::Reconnecting => {
            let reason = state
                .logs
                .back()
                .cloned()
                .unwrap_or_else(|| "接続できません".into());
            format!("{reason}\n再試行中: {}", state.server)
        }
    };
}

pub fn update_hud(
    state: Res<NetState>,
    player: Option<Res<LocalPlayer>>,
    mut text: Query<&mut Text, With<HudText>>,
) {
    let Some(mut text) = text.iter_mut().next() else {
        return;
    };
    let peers = state
        .projected
        .peers
        .keys()
        .filter(|id| Some(id.as_str()) != state.self_entity.as_deref())
        .count();
    let objects = state.projected.objects.len();
    let peer_names = state
        .projected
        .peers
        .iter()
        .filter(|(id, _)| Some(id.as_str()) != state.self_entity.as_deref())
        .map(|(_, peer)| peer.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let rtt = state
        .rtt_ms
        .map(|rtt| format!("{rtt} ms"))
        .unwrap_or_else(|| "-".into());
    let position = player
        .map(|player| {
            let [x, y, z] = player.position();
            format!("{x:.1}, {y:.1}, {z:.1}")
        })
        .unwrap_or_else(|| "-".into());
    let ipfs = state
        .ipfs_peer_id
        .as_deref()
        .map(|id| id.chars().take(16).collect::<String>())
        .unwrap_or_else(|| "未接続".into());
    let mut lines = vec![
        format!(
            "接続: {:?}  人数: {}  オブジェクト: {}",
            state.status,
            peers + 1,
            objects
        ),
        format!("RTT: {rtt}  位置: {position}  tick: {} Hz", state.tick_rate),
        format!("IPFS: {ipfs}"),
    ];
    if !peer_names.is_empty() {
        lines.push(format!("参加者: {peer_names}"));
    }
    lines.extend([
        "WASD 移動 / Shift 走る / Space ジャンプ / C しゃがみ / Q,E リーン".to_owned(),
        "右クリック つかむ / E 回転 / ホイール 距離 / Shift+ホイール 拡大 / M メニュー".to_owned(),
    ]);
    if let Some(notice) = &state.notice {
        lines.push(format!("> {notice}"));
    }
    for log in state.logs.iter().rev().take(3) {
        lines.push(format!("  {log}"));
    }
    text.0 = lines.join("\n");
}

pub fn ring_actions(
    mut menu: ResMut<RingMenu>,
    net: ResMut<NetHandle>,
    mut state: ResMut<NetState>,
    mut player: ResMut<LocalPlayer>,
    interactions: Query<(&Interaction, &RingButton), (Changed<Interaction>, With<Button>)>,
    content: Res<crate::content::ContentService>,
) {
    for (interaction, button) in &interactions {
        if *interaction != Interaction::Pressed {
            continue;
        }
        let Some(target) = menu.target.clone() else {
            continue;
        };
        match button.0 {
            RingAction::Delete => {
                crate::net::send_delete(net.as_ref(), &target);
                if player.grabbed_id.as_deref() == Some(target.as_str()) {
                    player.release_local();
                }
                state.log("削除しました");
            }
            RingAction::Duplicate => {
                crate::net::send_duplicate(net.as_ref(), &target);
                state.log("複製しました");
            }
            RingAction::Download => {
                if let Some(object) = state.projected.objects.get(&target)
                    && let Some(cid) = object_cid(object)
                {
                    let name = object_name(object);
                    let dir = dirs_download_dir();
                    content.fetch_to(cid, dir.join(name));
                    state.log("ダウンロードを開始しました");
                }
            }
            RingAction::Close => {}
        }
        menu.target = None;
    }
}

fn object_cid(object: &space_protocol::projection::WorldObject) -> Option<String> {
    match object {
        space_protocol::projection::WorldObject::Image(o) => Some(o.cid.clone()),
        space_protocol::projection::WorldObject::File(o) => Some(o.cid.clone()),
        _ => None,
    }
}

fn object_name(object: &space_protocol::projection::WorldObject) -> String {
    match object {
        space_protocol::projection::WorldObject::Image(o) => o
            .name
            .clone()
            .unwrap_or_else(|| format!("{}.png", o.base.id)),
        space_protocol::projection::WorldObject::File(o) => o.name.clone(),
        _ => "download.bin".into(),
    }
}

fn dirs_download_dir() -> std::path::PathBuf {
    directories::UserDirs::new()
        .and_then(|dirs| dirs.download_dir().map(|dir| dir.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

pub struct UiPlugin;

impl Plugin for UiPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, spawn_ui).add_systems(
            Update,
            (
                sync_visibility,
                lobby_actions,
                update_lobby_status,
                update_hud,
                ring_actions,
            ),
        );
    }
}
