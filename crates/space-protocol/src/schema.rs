use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

/// `packages/protocol/space-schema.json` をそのまま埋め込む。
/// TS 側と Rust 側で dimension 名・上限がずれないようにするための唯一の正。
const SPACE_SCHEMA_JSON: &str = include_str!("../../../packages/protocol/space-schema.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionSpec {
    #[serde(rename = "type")]
    pub kind: String,
    pub write: String,
    #[serde(default)]
    pub values: Option<Vec<String>>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub max_length: Option<usize>,
    #[serde(default)]
    pub nullable: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSchema {
    pub schema_version: u32,
    pub max_dimensions: usize,
    pub max_entity_bytes: usize,
    pub max_objects: usize,
    pub max_filter_predicates: usize,
    pub dimensions: HashMap<String, DimensionSpec>,
    pub required: HashMap<String, Vec<String>>,
}

static SCHEMA: OnceLock<SpaceSchema> = OnceLock::new();

pub fn schema() -> &'static SpaceSchema {
    SCHEMA.get_or_init(|| {
        serde_json::from_str(SPACE_SCHEMA_JSON).expect("embedded space-schema.json must be valid")
    })
}

pub fn dimension(name: &str) -> Option<&'static DimensionSpec> {
    schema().dimensions.get(name)
}

pub fn is_known_dimension(name: &str) -> bool {
    schema().dimensions.contains_key(name)
}

pub fn is_writable_dimension(name: &str) -> bool {
    dimension(name).is_some_and(|spec| {
        matches!(
            spec.write.as_str(),
            "client" | "create" | "claim" | "avatar"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MAX_OBJECTS, SPACE_SCHEMA_VERSION};

    #[test]
    fn embedded_schema_matches_protocol_constants() {
        let schema = schema();
        assert_eq!(schema.schema_version, SPACE_SCHEMA_VERSION);
        assert_eq!(schema.max_objects, MAX_OBJECTS);
        assert!(schema.max_dimensions >= schema.dimensions.len());
        assert!(schema.dimensions.contains_key("space.position"));
        assert!(schema.dimensions.contains_key("peer.avatarCid"));
        assert!(schema.required["peer"].contains(&"space.head".to_owned()));
    }

    #[test]
    fn writable_dimensions_are_limited() {
        assert!(is_writable_dimension("space.position"));
        assert!(is_writable_dimension("peer.ipfsPeerId"));
        assert!(!is_writable_dimension("peer.name"));
        assert!(!is_known_dimension("space.unknown"));
    }
}
