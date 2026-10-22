use space_protocol::messages::{ClientMessage, ServerMessage};
use space_protocol::projection::{WorldObject, project_entities};

const WELCOME: &str = include_str!("../../../packages/protocol/fixtures/space-v2/welcome.json");
const DELTA: &str = include_str!("../../../packages/protocol/fixtures/space-v2/delta.json");
const MUTATE: &str = include_str!("../../../packages/protocol/fixtures/space-v2/mutate.json");

#[test]
fn welcome_fixture_round_trips() {
    let message = ServerMessage::from_json(WELCOME).expect("welcome");
    let ServerMessage::SpaceWelcome {
        me,
        session_id,
        entities,
        ipfs,
        ..
    } = message
    else {
        panic!("expected welcome");
    };

    assert_eq!(me.name, "alice");
    assert_eq!(session_id, "main");
    assert_eq!(ipfs.ws_port, 8081);
    assert_eq!(entities.len(), 2);

    let world = project_entities(&entities);
    assert!(world.peers.contains_key("peer-self"));
    assert!(matches!(
        world.objects.get("box-1"),
        Some(WorldObject::Box(_))
    ));
}

#[test]
fn delta_fixture_applies_in_order() {
    let message = ServerMessage::from_json(DELTA).expect("delta");
    let ServerMessage::SpaceDelta { changes, seq, .. } = message else {
        panic!("expected delta");
    };
    assert_eq!(seq, 11);
    assert_eq!(changes.len(), 2);
}

#[test]
fn mutate_fixture_serializes_to_the_same_json() {
    let message: ClientMessage = serde_json::from_str(MUTATE).expect("mutate");
    let encoded: serde_json::Value = serde_json::to_value(message).expect("encode");
    let original: serde_json::Value = serde_json::from_str(MUTATE).expect("original");
    assert_eq!(encoded, original);
}
