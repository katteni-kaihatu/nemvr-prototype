use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::messages::{SpaceEntity, SpaceFilter, SpacePredicate};

pub type Vec3 = [f32; 3];
pub type Quat = [f32; 4];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pose {
    pub position: Vec3,
    pub head: Quat,
    pub crouch: f32,
    pub lean: f32,
}

impl Default for Pose {
    fn default() -> Self {
        Self {
            position: [0.0, 0.0, 0.0],
            head: [0.0, 0.0, 0.0, 1.0],
            crouch: 0.0,
            lean: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub avatar_cid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileCategory {
    Audio,
    Video,
    File,
}

impl FileCategory {
    fn parse(value: &str) -> Self {
        match value {
            "audio" => Self::Audio,
            "video" => Self::Video,
            _ => Self::File,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ObjectBase {
    pub id: String,
    pub position: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub scale: f32,
    pub held_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageObject {
    pub base: ObjectBase,
    pub cid: String,
    pub width: f32,
    pub height: f32,
    pub name: Option<String>,
    pub stored: bool,
    pub owner: Option<String>,
    pub offline: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileObject {
    pub base: ObjectBase,
    pub cid: String,
    pub name: String,
    pub size: u64,
    pub stored: bool,
    pub owner: Option<String>,
    pub offline: bool,
    pub category: FileCategory,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoxObject {
    pub base: ObjectBase,
    pub size: f32,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinkObject {
    pub base: ObjectBase,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorldObject {
    Image(ImageObject),
    File(FileObject),
    Box(BoxObject),
    Link(LinkObject),
}

impl WorldObject {
    pub fn id(&self) -> &str {
        match self {
            Self::Image(o) => &o.base.id,
            Self::File(o) => &o.base.id,
            Self::Box(o) => &o.base.id,
            Self::Link(o) => &o.base.id,
        }
    }

    pub fn base(&self) -> &ObjectBase {
        match self {
            Self::Image(o) => &o.base,
            Self::File(o) => &o.base,
            Self::Box(o) => &o.base,
            Self::Link(o) => &o.base,
        }
    }

    pub fn base_mut(&mut self) -> &mut ObjectBase {
        match self {
            Self::Image(o) => &mut o.base,
            Self::File(o) => &mut o.base,
            Self::Box(o) => &mut o.base,
            Self::Link(o) => &mut o.base,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoPlaybackState {
    pub playing: bool,
    pub time: f64,
    pub at: f64,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectedWorld {
    pub objects: HashMap<String, WorldObject>,
    pub peers: HashMap<String, PeerInfo>,
    pub video_states: HashMap<String, VideoPlaybackState>,
}

fn as_vec3(value: Option<&Value>, fallback: Vec3) -> Vec3 {
    match value {
        Some(Value::Array(items))
            if items.len() == 3 && items.iter().all(|v| v.as_f64().is_some_and(f64::is_finite)) =>
        {
            [
                items[0].as_f64().unwrap_or(0.0) as f32,
                items[1].as_f64().unwrap_or(0.0) as f32,
                items[2].as_f64().unwrap_or(0.0) as f32,
            ]
        }
        _ => fallback,
    }
}

fn as_quat(value: Option<&Value>) -> Quat {
    match value {
        Some(Value::Array(items))
            if items.len() == 4 && items.iter().all(|v| v.as_f64().is_some_and(f64::is_finite)) =>
        {
            [
                items[0].as_f64().unwrap_or(0.0) as f32,
                items[1].as_f64().unwrap_or(0.0) as f32,
                items[2].as_f64().unwrap_or(0.0) as f32,
                items[3].as_f64().unwrap_or(1.0) as f32,
            ]
        }
        _ => [0.0, 0.0, 0.0, 1.0],
    }
}

fn as_number(value: Option<&Value>, fallback: f32) -> f32 {
    match value.and_then(Value::as_f64) {
        Some(number) if number.is_finite() => number as f32,
        _ => fallback,
    }
}

fn as_u64(value: Option<&Value>, fallback: u64) -> u64 {
    match value.and_then(Value::as_u64) {
        Some(number) => number,
        None => match value.and_then(Value::as_f64) {
            Some(number) if number.is_finite() && number >= 0.0 => number as u64,
            _ => fallback,
        },
    }
}

fn as_string(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(text) => text.to_owned(),
        None => fallback.to_owned(),
    }
}

fn as_opt_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn as_bool(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn dim<'a>(dims: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    dims.get(name)
}

pub fn pose_from_entity(entity: &SpaceEntity) -> Pose {
    let dims = &entity.dimensions;
    Pose {
        position: as_vec3(dim(dims, "space.position"), [0.0, 0.0, 0.0]),
        head: as_quat(dim(dims, "space.head")),
        crouch: as_number(dim(dims, "space.crouch"), 0.0),
        lean: as_number(dim(dims, "space.lean"), 0.0),
    }
}

pub fn project_entity(entity: &SpaceEntity) -> Option<WorldObject> {
    let dims = &entity.dimensions;
    let kind = dims.get("entity.kind")?.as_str()?;
    if kind == "peer" {
        return None;
    }

    let base = ObjectBase {
        id: entity.id.clone(),
        position: as_vec3(dim(dims, "space.position"), [0.0, 0.0, 0.0]),
        yaw: as_number(dim(dims, "space.yaw"), 0.0),
        pitch: as_number(dim(dims, "space.pitch"), 0.0),
        scale: as_number(dim(dims, "space.scale"), 1.0),
        held_by: as_opt_string(dim(dims, "interaction.heldBy")),
    };

    match kind {
        "image" => Some(WorldObject::Image(ImageObject {
            base,
            cid: as_string(dim(dims, "content.cid"), ""),
            width: as_number(dim(dims, "content.width"), 1.0),
            height: as_number(dim(dims, "content.height"), 1.0),
            name: as_opt_string(dim(dims, "content.name")),
            stored: as_bool(dim(dims, "content.stored"), false),
            owner: as_opt_string(dim(dims, "content.owner")),
            offline: as_bool(dim(dims, "content.offline"), false),
        })),
        "file" => Some(WorldObject::File(FileObject {
            base,
            cid: as_string(dim(dims, "content.cid"), ""),
            name: as_string(dim(dims, "content.name"), "file"),
            size: as_u64(dim(dims, "content.size"), 0),
            stored: as_bool(dim(dims, "content.stored"), false),
            owner: as_opt_string(dim(dims, "content.owner")),
            offline: as_bool(dim(dims, "content.offline"), false),
            category: FileCategory::parse(&as_string(dim(dims, "content.category"), "file")),
        })),
        "box" => Some(WorldObject::Box(BoxObject {
            base,
            size: as_number(dim(dims, "box.size"), 1.0),
            color: as_string(dim(dims, "box.color"), "#888888"),
        })),
        "link" => Some(WorldObject::Link(LinkObject {
            base,
            url: as_string(dim(dims, "content.url"), ""),
        })),
        _ => None,
    }
}

pub fn project_peer(entity: &SpaceEntity) -> PeerInfo {
    let dims = &entity.dimensions;
    PeerInfo {
        id: entity.id.clone(),
        name: as_string(dim(dims, "peer.name"), "Guest"),
        color: as_string(dim(dims, "peer.color"), "#888888"),
        avatar_cid: as_opt_string(dim(dims, "peer.avatarCid")),
    }
}

pub fn project_entities<'a>(entities: impl IntoIterator<Item = &'a SpaceEntity>) -> ProjectedWorld {
    let mut world = ProjectedWorld::default();

    for entity in entities {
        let dims = &entity.dimensions;
        match dims.get("entity.kind").and_then(Value::as_str) {
            Some("peer") => {
                world.peers.insert(entity.id.clone(), project_peer(entity));
            }
            _ => {
                if let Some(object) = project_entity(entity) {
                    world.objects.insert(object.id().to_owned(), object);
                }
            }
        }

        if let Some(Value::Object(playback)) = dims.get("time.playback") {
            world.video_states.insert(
                entity.id.clone(),
                VideoPlaybackState {
                    playing: as_bool(playback.get("playing"), false),
                    time: playback.get("time").and_then(Value::as_f64).unwrap_or(0.0),
                    at: playback.get("at").and_then(Value::as_f64).unwrap_or(0.0),
                },
            );
        }
    }

    world
}

/// `SpaceFilter` が、指定した session の全エンティティを読むための既定値。
pub fn session_filter(session_id: &str) -> SpaceFilter {
    SpaceFilter {
        all: Some(vec![SpacePredicate::Eq {
            dim: "session.id".to_owned(),
            eq: Value::String(session_id.to_owned()),
        }]),
        any: None,
        not: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entity(dimensions: Value) -> SpaceEntity {
        SpaceEntity {
            id: "e1".into(),
            version: 3,
            dimensions: dimensions.as_object().unwrap().clone(),
        }
    }

    #[test]
    fn image_projection_uses_fallbacks() {
        let object = project_entity(&entity(json!({
            "entity.kind": "image",
            "space.position": [1, 2, 3],
        })))
        .unwrap();

        let WorldObject::Image(image) = object else {
            panic!("expected image");
        };
        assert_eq!(image.base.position, [1.0, 2.0, 3.0]);
        assert_eq!(image.width, 1.0);
        assert_eq!(image.height, 1.0);
        assert_eq!(image.cid, "");
        assert!(!image.stored);
    }

    #[test]
    fn peer_projection_keeps_avatar() {
        let peer = project_peer(&entity(json!({
            "entity.kind": "peer",
            "space.position": [0, 0, 0],
            "space.head": [0, 0, 0, 1],
            "peer.name": "alice",
            "peer.color": "#112233",
            "peer.avatarCid": "bafy",
        })));
        assert_eq!(peer.name, "alice");
        assert_eq!(peer.avatar_cid.as_deref(), Some("bafy"));
    }

    #[test]
    fn file_category_and_playback_are_projected() {
        let e = entity(json!({
            "entity.kind": "file",
            "space.position": [0, 0, 0],
            "content.cid": "bafy",
            "content.name": "clip.mp4",
            "content.size": 12,
            "content.category": "video",
            "time.playback": { "playing": true, "time": 4.5, "at": 1000 },
        }));
        let projected = project_entities([&e]);
        let WorldObject::File(file) = projected.objects.get("e1").unwrap() else {
            panic!("expected file");
        };
        assert_eq!(file.category, FileCategory::Video);
        assert_eq!(projected.video_states["e1"].time, 4.5);
    }

    #[test]
    fn malformed_numbers_fall_back() {
        let pose = pose_from_entity(&entity(json!({
            "entity.kind": "peer",
            "space.position": ["x", 0, 0],
        })));
        assert_eq!(pose.position, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn session_filter_matches_web_default() {
        let filter = session_filter("main");
        assert_eq!(
            serde_json::to_value(filter).unwrap(),
            json!({ "all": [{ "dim": "session.id", "eq": "main" }] })
        );
    }
}
