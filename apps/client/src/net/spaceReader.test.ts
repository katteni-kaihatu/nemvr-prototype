import { describe, expect, it } from "vitest";
import type { ServerMessage, SpaceEntity } from "@proto/protocol";
import { SpaceReader } from "./spaceReader";

const entity = (id: string, version: number): SpaceEntity => ({
  id,
  version,
  dimensions: {
    "entity.kind": "box",
    "space.position": [version, 0, 0],
    "space.yaw": 0,
    "box.size": 1,
    "box.color": "#aabbcc",
  },
});

const welcome = (): Extract<ServerMessage, { type: "space_welcome" }> => ({
  type: "space_welcome",
  self: { peerId: "peer-1", entityId: "peer-1", name: "alice", color: "#123456" },
  sessionId: "main",
  templateId: "vr-sns-3d",
  schemaVersion: 1,
  scope: {
    sessionId: "main",
    read: { dims: [], filter: { all: [{ dim: "session.id", eq: "main" }] } },
    write: {
      dims: [],
      filter: { all: [{ dim: "session.id", eq: "main" }] },
      canCreate: true,
      canDelete: true,
      maxEntities: 100,
    },
  },
  dimensions: {},
  subscriptionId: "sub-0",
  version: 1,
  seq: 0,
  at: 1000,
  entities: [entity("box-1", 1)],
  ipfs: { peerId: "kubo", wsPort: 8081 },
  tickRate: 20,
});

describe("SpaceReader", () => {
  it("applies welcome, delta and remove", () => {
    const reader = new SpaceReader();
    reader.applyWelcome(welcome());
    expect(reader.entities.size).toBe(1);
    expect(reader.seq).toBe(0);

    expect(
      reader.applyDelta({
        type: "space_delta",
        subscriptionId: "sub-0",
        version: 2,
        seq: 1,
        at: 1050,
        changes: [{ op: "upsert", entity: entity("box-2", 2) }],
      }),
    ).toBe(true);

    expect(reader.entities.size).toBe(2);
    expect(reader.version).toBe(2);

    expect(
      reader.applyDelta({
        type: "space_delta",
        subscriptionId: "sub-0",
        version: 3,
        seq: 2,
        at: 1100,
        changes: [{ op: "remove", id: "box-1", version: 3 }],
      }),
    ).toBe(true);

    expect(reader.entities.has("box-1")).toBe(false);
    expect(reader.entities.has("box-2")).toBe(true);
  });

  it("rejects stale or gapped deltas", () => {
    const reader = new SpaceReader();
    reader.applyWelcome(welcome());

    expect(
      reader.applyDelta({
        type: "space_delta",
        subscriptionId: "sub-0",
        version: 2,
        seq: 2,
        at: 1050,
        changes: [{ op: "upsert", entity: entity("box-2", 2) }],
      }),
    ).toBe(false);

    expect(reader.entities.size).toBe(1);
  });

  it("ignores deltas from another subscription", () => {
    const reader = new SpaceReader();
    reader.applyWelcome(welcome());

    expect(
      reader.applyDelta({
        type: "space_delta",
        subscriptionId: "other",
        version: 2,
        seq: 1,
        at: 1050,
        changes: [{ op: "upsert", entity: entity("box-2", 2) }],
      }),
    ).toBe(false);
  });
});
