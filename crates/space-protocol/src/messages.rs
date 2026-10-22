use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type JsonValue = Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceEntity {
    pub id: String,
    pub version: u64,
    pub dimensions: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangePredicate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SpacePredicate {
    Eq { dim: String, eq: Value },
    In { dim: String, r#in: Vec<Value> },
    Range { dim: String, range: RangePredicate },
    Within { dim: String, within: Bounds },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<Vec<SpacePredicate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any: Option<Vec<SpacePredicate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not: Option<Box<SpaceFilter>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceReadScope {
    pub dims: Vec<String>,
    pub filter: SpaceFilter,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceWriteScope {
    pub dims: Vec<String>,
    pub filter: SpaceFilter,
    pub can_create: bool,
    pub can_delete: bool,
    pub max_entities: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceScope {
    pub session_id: String,
    pub read: SpaceReadScope,
    pub write: SpaceWriteScope,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCondition {
    pub dim: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eq: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_absent: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SpaceMutation {
    Create {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        dimensions: Map<String, Value>,
    },
    Patch {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set: Option<Map<String, Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unset: Option<Vec<String>>,
        #[serde(default, rename = "if", skip_serializing_if = "Option::is_none")]
        conditions: Option<Vec<SpaceCondition>>,
        #[serde(default, rename = "ifVersion", skip_serializing_if = "Option::is_none")]
        if_version: Option<u64>,
    },
    Delete {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        #[serde(default, rename = "if", skip_serializing_if = "Option::is_none")]
        conditions: Option<Vec<SpaceCondition>>,
        #[serde(default, rename = "ifVersion", skip_serializing_if = "Option::is_none")]
        if_version: Option<u64>,
    },
    Duplicate {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        #[serde(rename = "newEntityId")]
        new_entity_id: String,
    },
    Claim {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
    },
    Release {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
    },
}

impl SpaceMutation {
    pub fn command_id(&self) -> &str {
        match self {
            Self::Create { command_id, .. }
            | Self::Patch { command_id, .. }
            | Self::Delete { command_id, .. }
            | Self::Duplicate { command_id, .. }
            | Self::Claim { command_id, .. }
            | Self::Release { command_id, .. } => command_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeOp {
    Upsert,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceChange {
    pub op: ChangeOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity: Option<SpaceEntity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSelf {
    pub peer_id: String,
    pub entity_id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpfsInfo {
    pub peer_id: String,
    pub ws_port: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    SpaceJoin {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        template_id: String,
        schema_version: u32,
    },
    SpacePing {
        id: u64,
    },
    SpaceQuery {
        request_id: String,
        filter: SpaceFilter,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<usize>,
    },
    SpaceSubscribe {
        subscription_id: String,
        filter: SpaceFilter,
    },
    SpaceUnsubscribe {
        subscription_id: String,
    },
    SpaceMutate {
        mutation: SpaceMutation,
    },
    SpaceImportUrl {
        command_id: String,
        entity_id: String,
        url: String,
        position: [f64; 3],
        yaw: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pitch: Option<f64>,
    },
    SpaceSetAvatar {
        command_id: String,
        cid: Option<String>,
    },
    FileRequest {
        command_id: String,
        entity_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[allow(clippy::large_enum_variant)]
pub enum ServerMessage {
    SpacePong {
        id: u64,
    },
    SpaceWelcome {
        #[serde(rename = "self")]
        me: SpaceSelf,
        session_id: String,
        template_id: String,
        schema_version: u32,
        scope: SpaceScope,
        dimensions: Map<String, Value>,
        subscription_id: String,
        version: u64,
        seq: u64,
        at: f64,
        entities: Vec<SpaceEntity>,
        ipfs: IpfsInfo,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ice_servers: Option<Vec<IceServer>>,
        tick_rate: u32,
    },
    SpaceSnapshot {
        subscription_id: String,
        version: u64,
        seq: u64,
        at: f64,
        entities: Vec<SpaceEntity>,
    },
    SpaceDelta {
        subscription_id: String,
        version: u64,
        seq: u64,
        at: f64,
        changes: Vec<SpaceChange>,
    },
    SpaceQueryResult {
        request_id: String,
        version: u64,
        entities: Vec<SpaceEntity>,
    },
    SpaceAck {
        command_id: String,
        version: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entity_id: Option<String>,
    },
    SpaceError {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        code: String,
        message: String,
    },
    FileProgress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entity_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cid: Option<String>,
        loaded: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queued: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<String>,
    },
    FileFailed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entity_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cid: Option<String>,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<String>,
    },
}

impl ClientMessage {
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

impl ServerMessage {
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_matches_the_wire_format() {
        let message = ClientMessage::SpaceJoin {
            name: "alice".into(),
            session_id: None,
            template_id: crate::SPACE_TEMPLATE_ID.into(),
            schema_version: crate::SPACE_SCHEMA_VERSION,
        };

        let json = message.to_json().unwrap();
        assert_eq!(
            json,
            r#"{"type":"space_join","name":"alice","templateId":"vr-sns-3d","schemaVersion":1}"#
        );
        let decoded: ClientMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, message);
    }

    #[test]
    fn pose_patch_matches_the_wire_format() {
        let mutation = SpaceMutation::Patch {
            command_id: "c1".into(),
            entity_id: "e1".into(),
            set: Some(
                serde_json::json!({
                    "space.position": [1.0, 2.0, 3.0],
                    "space.head": [0.0, 0.0, 0.0, 1.0],
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
            unset: None,
            conditions: None,
            if_version: Some(7),
        };

        let json = ClientMessage::SpaceMutate { mutation }.to_json().unwrap();
        assert_eq!(
            json,
            r#"{"type":"space_mutate","mutation":{"op":"patch","commandId":"c1","entityId":"e1","set":{"space.head":[0.0,0.0,0.0,1.0],"space.position":[1.0,2.0,3.0]},"ifVersion":7}}"#
        );
    }

    #[test]
    fn unknown_type_is_rejected() {
        assert!(ServerMessage::from_json(r#"{"type":"snapshot"}"#).is_err());
    }
}
