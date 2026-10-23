use std::collections::HashMap;

use space_protocol::messages::{ChangeOp, SpaceChange, SpaceEntity};

#[derive(Debug, Clone, Default)]
pub struct SpaceStore {
    pub entities: HashMap<String, SpaceEntity>,
    pub version: u64,
    pub seq: u64,
    pub subscription_id: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyError {
    Gap { expected: u64, received: u64 },
    WrongSubscription,
}

impl SpaceStore {
    pub fn replace(
        &mut self,
        subscription_id: String,
        version: u64,
        seq: u64,
        entities: Vec<SpaceEntity>,
    ) {
        self.entities = entities
            .into_iter()
            .map(|entity| (entity.id.clone(), entity))
            .collect();
        self.version = version;
        self.seq = seq;
        self.subscription_id = Some(subscription_id);
        self.dirty = true;
    }

    pub fn apply_delta(
        &mut self,
        subscription_id: &str,
        version: u64,
        seq: u64,
        changes: Vec<SpaceChange>,
    ) -> Result<(), ApplyError> {
        if self.subscription_id.as_deref() != Some(subscription_id) {
            return Err(ApplyError::WrongSubscription);
        }
        let expected = self.seq.saturating_add(1);
        if seq != expected {
            return Err(ApplyError::Gap {
                expected,
                received: seq,
            });
        }

        for change in changes {
            match change.op {
                ChangeOp::Upsert => {
                    if let Some(entity) = change.entity
                        && entity.version
                            >= self.entities.get(&entity.id).map_or(0, |old| old.version)
                    {
                        self.entities.insert(entity.id.clone(), entity);
                    }
                }
                ChangeOp::Remove => {
                    if let Some(id) = change.id {
                        let keep = self.entities.get(&id).is_some_and(|old| {
                            change.version.is_some_and(|version| version < old.version)
                        });
                        if !keep {
                            self.entities.remove(&id);
                        }
                    }
                }
            }
        }

        self.version = version;
        self.seq = seq;
        self.dirty = true;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&SpaceEntity> {
        self.entities.get(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entity(id: &str, version: u64) -> SpaceEntity {
        SpaceEntity {
            id: id.into(),
            version,
            dimensions: json!({ "entity.kind": "peer" })
                .as_object()
                .unwrap()
                .clone(),
        }
    }

    #[test]
    fn delta_applies_only_in_sequence() {
        let mut store = SpaceStore::default();
        store.replace("s".into(), 1, 1, vec![entity("a", 1)]);

        let result = store.apply_delta(
            "s",
            2,
            3,
            vec![SpaceChange {
                op: ChangeOp::Upsert,
                entity: Some(entity("a", 2)),
                id: None,
                version: None,
            }],
        );
        assert!(matches!(
            result,
            Err(ApplyError::Gap {
                expected: 2,
                received: 3
            })
        ));
        assert_eq!(store.entities["a"].version, 1);

        store
            .apply_delta(
                "s",
                2,
                2,
                vec![SpaceChange {
                    op: ChangeOp::Upsert,
                    entity: Some(entity("a", 2)),
                    id: None,
                    version: None,
                }],
            )
            .unwrap();
        assert_eq!(store.entities["a"].version, 2);
    }

    #[test]
    fn stale_versions_do_not_overwrite() {
        let mut store = SpaceStore::default();
        store.replace("s".into(), 5, 5, vec![entity("a", 5)]);
        store
            .apply_delta(
                "s",
                6,
                6,
                vec![SpaceChange {
                    op: ChangeOp::Upsert,
                    entity: Some(entity("a", 4)),
                    id: None,
                    version: None,
                }],
            )
            .unwrap();
        assert_eq!(store.entities["a"].version, 5);
    }

    #[test]
    fn remove_deletes_entity() {
        let mut store = SpaceStore::default();
        store.replace("s".into(), 1, 1, vec![entity("a", 1)]);
        store
            .apply_delta(
                "s",
                2,
                2,
                vec![SpaceChange {
                    op: ChangeOp::Remove,
                    entity: None,
                    id: Some("a".into()),
                    version: Some(2),
                }],
            )
            .unwrap();
        assert!(!store.entities.contains_key("a"));
    }

    #[test]
    fn unknown_dimensions_survive_and_scope_removal_needs_no_tombstone_version() {
        let mut store = SpaceStore::default();
        let mut item = entity("custom", 7);
        item.dimensions
            .insert("unknown.axis".into(), json!({"opaque":[1,2,3]}));
        store.replace("s".into(), 7, 0, vec![item]);
        assert_eq!(
            store.entities["custom"].dimensions["unknown.axis"],
            json!({"opaque":[1,2,3]})
        );
        store
            .apply_delta(
                "s",
                7,
                1,
                vec![SpaceChange {
                    op: ChangeOp::Remove,
                    entity: None,
                    id: Some("custom".into()),
                    version: None,
                }],
            )
            .unwrap();
        assert!(store.entities.is_empty());
    }

    #[test]
    fn stale_subscription_and_pre_snapshot_deltas_are_ignored() {
        let mut store = SpaceStore::default();
        assert_eq!(
            store.apply_delta("old", 1, 1, vec![]),
            Err(ApplyError::WrongSubscription)
        );
        store.replace("new".into(), 1, 0, vec![entity("a", 1)]);
        assert_eq!(
            store.apply_delta("old", 2, 1, vec![]),
            Err(ApplyError::WrongSubscription)
        );
        assert_eq!(store.seq, 0);
        assert!(store.entities.contains_key("a"));
    }
}
