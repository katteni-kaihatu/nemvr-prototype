import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BoxObject, FileObject, Vec3, WorldObject } from "@proto/protocol";
import { DEMO_BOXES, WorldDoc, seedDemoBoxes } from "./doc.js";
import { isValidTransform } from "./validate.js";

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function makeBox(id: string, position: Vec3 = [0, 0, 0]): BoxObject {
  return { id, kind: "box", position, yaw: 0, size: 1, color: "#d9534f" };
}

function makeFile(id: string): FileObject {
  return {
    id,
    kind: "file",
    position: [1, 0, 0],
    yaw: 0,
    cid: "bafybeigdyrzt",
    name: "document.txt",
    size: 10,
    stored: false,
    category: "file",
  };
}

function makeWorld(actorId = "actor-a"): WorldDoc {
  return new WorldDoc({ actorId, now: () => 1_000_000 });
}

function capture(world: WorldDoc, action: () => void): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const unsubscribe = world.onUpdate((update) => updates.push(update));
  try {
    action();
  } finally {
    unsubscribe();
  }
  return updates;
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const a = result[i]!;
    const b = result[j]!;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

describe("WorldDoc basics", () => {
  it("creates, moves and projects objects sorted by id", () => {
    const world = makeWorld();
    const first = makeBox(uuid(2), [1, 2, 3]);
    const second = makeBox(uuid(1), [-1, 0, 1]);

    expect(world.createObject(first)).toBe(true);
    expect(world.createObject(second)).toBe(true);
    expect(world.createObject(first)).toBe(false);
    expect(world.getObjects().map((object) => object.id)).toEqual([uuid(1), uuid(2)]);
    expect(world.count()).toBe(2);

    expect(world.moveObject(uuid(2), [4, 5, 6], 0.25, 0.5)).toBe(true);
    const moved = world.getObject(uuid(2));
    expect(moved).toBeDefined();
    expect(moved!.position).toEqual([4, 5, 6]);
    expect(moved!.yaw).toBe(0.25);
    expect(moved!.pitch).toBe(0.5);
    expect(world.moveObject(uuid(999), [0, 0, 0], 0)).toBe(false);
  });

  it("clones positions so callers cannot mutate the document", () => {
    const world = makeWorld();
    const input = makeBox(uuid(1), [7, 8, 9]);
    expect(world.createObject(input)).toBe(true);
    input.position[0] = 100;
    expect(world.getObject(uuid(1))!.position).toEqual([7, 8, 9]);

    const projected = world.getObject(uuid(1))!;
    projected.position[0] = 55;
    expect(world.getObject(uuid(1))!.position).toEqual([7, 8, 9]);

    const next: Vec3 = [1, 1, 1];
    expect(world.moveObject(uuid(1), next, 0)).toBe(true);
    next[1] = 99;
    expect(world.getObject(uuid(1))!.position).toEqual([1, 1, 1]);
  });

  it("keeps metadata separate from transform", () => {
    const world = makeWorld();
    const file = makeFile(uuid(3));
    expect(world.createObject(file)).toBe(true);

    expect(
      world.setMetadata(uuid(3), {
        stored: true,
        size: 42,
        category: "video",
        owner: "bob",
        name: "renamed.mp4",
      }),
    ).toBe(true);
    expect(world.moveObject(uuid(3), [5, 0, 0], 0.5)).toBe(true);

    const projected = world.getObject(uuid(3)) as FileObject;
    expect(projected.stored).toBe(true);
    expect(projected.size).toBe(42);
    expect(projected.category).toBe("video");
    expect(projected.owner).toBe("bob");
    expect(projected.name).toBe("renamed.mp4");
    expect(projected.offline).toBeUndefined();
    expect(projected.position).toEqual([5, 0, 0]);

    expect(world.setMetadata(uuid(3), { offline: true })).toBe(true);
    expect((world.getObject(uuid(3)) as FileObject).offline).toBe(true);
    expect(world.setMetadata(uuid(3), { offline: false, owner: undefined })).toBe(true);
    const cleared = world.getObject(uuid(3)) as FileObject;
    expect(cleared.offline).toBeUndefined();
    expect(cleared.owner).toBeUndefined();
  });

  it("defaults file stored to false when absent", () => {
    const world = makeWorld();
    const file = makeFile(uuid(4));
    expect(world.createObject(file)).toBe(true);
    const record = world.doc.getMap<Y.Map<unknown>>("objects").get(uuid(4))!;
    record.delete("stored");
    expect((world.getObject(uuid(4)) as FileObject).stored).toBe(false);
  });
});

describe("tombstones", () => {
  it("deletes idempotently and never resurrects", () => {
    const world = makeWorld();
    const id = uuid(10);
    expect(world.createObject(makeBox(id))).toBe(true);

    expect(world.deleteObject(id)).toBe(true);
    expect(world.deleteObject(id)).toBe(true);
    expect(world.isDeleted(id)).toBe(true);
    expect(world.getObject(id)).toBeUndefined();
    expect(world.count()).toBe(0);

    expect(world.moveObject(id, [1, 0, 0], 0)).toBe(false);
    expect(world.setMetadata(id, { size: 3 })).toBe(false);
    expect(world.createObject(makeBox(id))).toBe(false);
    expect(world.isDeleted(id)).toBe(true);
  });

  it("tombstones unknown ids so they cannot be created later", () => {
    const world = makeWorld();
    const id = uuid(11);
    expect(world.deleteObject(id)).toBe(true);
    expect(world.createObject(makeBox(id))).toBe(false);
  });

  it("duplicates with a new id without touching the source", () => {
    const world = makeWorld();
    const source = makeBox(uuid(20), [1, 0, 0]);
    expect(world.createObject(source)).toBe(true);

    const copy = makeBox(uuid(21), [2, 0, 0]);
    expect(world.duplicateObject(uuid(20), copy)).toBe(true);
    expect(world.count()).toBe(2);
    expect(world.getObject(uuid(20))!.position).toEqual([1, 0, 0]);
    expect(world.getObject(uuid(21))).toBeDefined();

    expect(world.duplicateObject(uuid(20), makeBox(uuid(20)))).toBe(false);
    expect(world.duplicateObject(uuid(20), makeBox(uuid(21)))).toBe(false);
    expect(world.duplicateObject(uuid(999), makeBox(uuid(22)))).toBe(false);
  });

  it("does not duplicate a deleted source", () => {
    const world = makeWorld();
    expect(world.createObject(makeBox(uuid(23)))).toBe(true);
    expect(world.deleteObject(uuid(23))).toBe(true);
    expect(world.duplicateObject(uuid(23), makeBox(uuid(24)))).toBe(false);
  });
});

describe("snapshot import", () => {
  it("replaceFromSnapshot tombstones live ids that are absent", () => {
    const world = makeWorld();
    expect(world.createObject(makeBox(uuid(30)))).toBe(true);
    expect(world.createObject(makeBox(uuid(31)))).toBe(true);

    const snapshot: WorldObject[] = [makeBox(uuid(30), [5, 0, 0]), makeBox(uuid(32), [6, 0, 0])];
    world.replaceFromSnapshot(snapshot);

    expect(world.getObjects().map((object) => object.id)).toEqual([uuid(30), uuid(32)]);
    expect(world.getObject(uuid(30))!.position).toEqual([5, 0, 0]);
    expect(world.isDeleted(uuid(31))).toBe(true);
    expect(world.createObject(makeBox(uuid(31)))).toBe(false);
  });

  it("mergeFromSnapshot never tombstones local objects", () => {
    const world = makeWorld();
    expect(world.createObject(makeBox(uuid(33)))).toBe(true);
    expect(world.createObject(makeBox(uuid(34)))).toBe(true);

    world.mergeFromSnapshot([makeBox(uuid(33), [8, 0, 0]), makeBox(uuid(35), [9, 0, 0])]);

    expect(world.getObjects().map((object) => object.id)).toEqual([uuid(33), uuid(34), uuid(35)]);
    expect(world.getObject(uuid(33))!.position).toEqual([8, 0, 0]);
    expect(world.isDeleted(uuid(34))).toBe(false);
  });

  it("ignores tombstones when importing a snapshot", () => {
    const world = makeWorld();
    expect(world.createObject(makeBox(uuid(36)))).toBe(true);
    expect(world.deleteObject(uuid(36))).toBe(true);
    world.mergeFromSnapshot([makeBox(uuid(36))]);
    expect(world.getObject(uuid(36))).toBeUndefined();
  });
});

describe("seeding", () => {
  it("seeds exactly once across save and load", () => {
    expect(DEMO_BOXES.map((box) => box.position)).toEqual([
      [0, 0, 0],
      [6, 0, -4],
      [-7, 0, -6],
      [10, 0, 8],
      [-10, 0, 7],
    ]);

    const world = makeWorld();
    seedDemoBoxes(world);
    expect(world.count()).toBe(5);
    seedDemoBoxes(world);
    expect(world.count()).toBe(5);

    const loaded = WorldDoc.fromUpdate(world.encodeUpdate(), {
      actorId: "actor-b",
      now: () => 2_000_000,
    });
    seedDemoBoxes(loaded);
    expect(loaded.count()).toBe(5);
  });
});

describe("projection hardening", () => {
  it("skips malformed records instead of throwing", () => {
    const world = makeWorld();
    const valid = makeBox(uuid(40));
    expect(world.createObject(valid)).toBe(true);

    const objects = world.doc.getMap<Y.Map<unknown>>("objects");
    const transform = { position: [0, 0, 0], yaw: 0, updateId: "u", actorId: "a", at: 1 };

    const missingFields = new Y.Map<unknown>();
    missingFields.set("kind", "box");
    missingFields.set("transform", transform);
    objects.set(uuid(41), missingFields);

    const badPitch = new Y.Map<unknown>();
    badPitch.set("kind", "box");
    badPitch.set("transform", { ...transform, pitch: "high" });
    badPitch.set("size", 1);
    badPitch.set("color", "#ffffff");
    objects.set(uuid(42), badPitch);

    const nestedTransform = new Y.Map<unknown>();
    nestedTransform.set("kind", "box");
    nestedTransform.set("transform", new Y.Map());
    nestedTransform.set("size", 1);
    nestedTransform.set("color", "#ffffff");
    objects.set(uuid(43), nestedTransform);

    const unknownKind = new Y.Map<unknown>();
    unknownKind.set("kind", "sphere");
    unknownKind.set("transform", transform);
    unknownKind.set("size", 1);
    unknownKind.set("color", "#ffffff");
    objects.set(uuid(44), unknownKind);

    const invalidId = new Y.Map<unknown>();
    invalidId.set("kind", "box");
    invalidId.set("transform", transform);
    invalidId.set("size", 1);
    invalidId.set("color", "#ffffff");
    objects.set("not-a-uuid", invalidId);

    objects.set(uuid(45), "not a map" as unknown as Y.Map<unknown>);

    expect(world.getObjects().map((object) => object.id)).toEqual([uuid(40)]);
    expect(world.count()).toBe(1);
  });

  it("validates transforms", () => {
    expect(
      isValidTransform({ position: [0, 0, 0], yaw: 0, updateId: "u", actorId: "a", at: 1 }),
    ).toBe(true);
    expect(
      isValidTransform({ position: [0, Number.NaN, 0], yaw: 0, updateId: "u", actorId: "a", at: 1 }),
    ).toBe(false);
    expect(isValidTransform(new Y.Map())).toBe(false);
    expect(isValidTransform({ position: [0, 0, 0], yaw: 0, updateId: "", actorId: "a", at: 1 })).toBe(
      false,
    );
  });
});

describe("replica convergence", () => {
  it("converges after lossy, duplicated and reordered delivery", () => {
    const origin = makeWorld("replica-0");
    const ids = [uuid(50), uuid(51), uuid(52)];
    const initial = capture(origin, () => {
      expect(origin.createObject(makeBox(ids[0]!, [0, 0, 0]))).toBe(true);
      expect(origin.createObject(makeBox(ids[1]!, [1, 0, 0]))).toBe(true);
      expect(origin.createObject(makeBox(ids[2]!, [2, 0, 0]))).toBe(true);
    });

    const base = origin.encodeUpdate();
    const w0 = origin;
    const w1 = WorldDoc.fromUpdate(base, { actorId: "replica-1", now: () => 1_000_000 });
    const w2 = WorldDoc.fromUpdate(base, { actorId: "replica-2", now: () => 1_000_000 });

    const updates0 = capture(w0, () => {
      expect(w0.moveObject(ids[0]!, [10, 0, 0], 0.5)).toBe(true);
    });
    const updates1 = capture(w1, () => {
      expect(w1.deleteObject(ids[1]!)).toBe(true);
    });
    const updates2 = capture(w2, () => {
      expect(w2.duplicateObject(ids[2]!, makeBox(uuid(53), [3, 0, 0]))).toBe(true);
    });

    const all = [...initial, ...updates0, ...updates1, ...updates2];
    const replicas = [w0, w1, w2];

    for (const replica of replicas) {
      const first = shuffle(all, 0x1234);
      for (let i = 0; i < first.length; i++) {
        if (i % 4 === 0) continue;
        replica.applyUpdate(first[i]!);
        if (i % 3 === 0) replica.applyUpdate(first[i]!);
      }
    }
    for (const replica of replicas) {
      for (const update of shuffle(all, 0x9999)) replica.applyUpdate(update);
    }

    const canonical = JSON.stringify(w0.getObjects());
    expect(JSON.stringify(w1.getObjects())).toBe(canonical);
    expect(JSON.stringify(w2.getObjects())).toBe(canonical);
    expect(w0.getObjects().map((object) => object.id)).toEqual([ids[0], ids[2], uuid(53)]);

    const tombstones = [ids[0]!, ids[1]!, ids[2]!, uuid(53)].map((id) => w0.isDeleted(id));
    expect([w1, w2].map((world) => [ids[0]!, ids[1]!, ids[2]!, uuid(53)].map((id) => world.isDeleted(id)))).toEqual([
      tombstones,
      tombstones,
    ]);
    expect(tombstones).toEqual([false, true, false, false]);
  });

  it("converges simultaneous transforms to one deterministic position", () => {
    const origin = makeWorld("replica-0");
    const id = uuid(60);
    const initial = capture(origin, () => {
      expect(origin.createObject(makeBox(id))).toBe(true);
    });
    const base = origin.encodeUpdate();
    const w1 = WorldDoc.fromUpdate(base, { actorId: "replica-1", now: () => 1_000_000 });
    const w2 = WorldDoc.fromUpdate(base, { actorId: "replica-2", now: () => 1_000_000 });

    const moveA = capture(origin, () => {
      expect(origin.moveObject(id, [1, 2, 3], 0.1, undefined, { updateId: "move-a" })).toBe(true);
    });
    const moveB = capture(w1, () => {
      expect(w1.moveObject(id, [9, 9, 9], 0.9, undefined, { updateId: "move-b" })).toBe(true);
    });

    for (const update of [...initial, ...moveA, ...moveB]) {
      origin.applyUpdate(update);
      w1.applyUpdate(update);
      w2.applyUpdate(update);
    }
    for (const update of [...moveA, ...moveB]) {
      w2.applyUpdate(update);
      w1.applyUpdate(update);
    }

    const a = origin.getObject(id);
    const b = w1.getObject(id);
    const c = w2.getObject(id);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    expect(b!.position).toEqual(a!.position);
    expect(c!.position).toEqual(a!.position);
    expect(b!.yaw).toBe(a!.yaw);
    expect(c!.yaw).toBe(a!.yaw);
    expect([
      [1, 2, 3],
      [9, 9, 9],
    ]).toContainEqual(a!.position);
  });
});
