import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  MAX_ABS_POSITION,
  MAX_FILE_NAME_LENGTH,
  MAX_URL_LENGTH,
} from "@proto/protocol";
import type { BoxObject, FileObject, ImageObject, LinkObject, Vec3, WorldObject } from "@proto/protocol";
import { DEMO_BOXES, WorldDoc, seedDemoBoxes } from "./doc.js";
import type { ObjectMetadataPatch, WorldTransform } from "./types.js";
import { MAX_CID_LENGTH, isValidObjectId, isValidTransform } from "./validate.js";

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

function makeImage(id: string, position: Vec3 = [0, 0, 0]): ImageObject {
  return {
    id,
    kind: "image",
    position,
    yaw: 0,
    cid: "bafybeigdyrztimage",
    width: 1,
    height: 1,
  };
}

function makeLink(id: string, url = "https://example.com/"): LinkObject {
  return { id, kind: "link", position: [0, 0, 0], yaw: 0, url };
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

describe("metadata by object kind", () => {
  it("rejects every patch on boxes and keeps them visible", () => {
    const world = makeWorld();
    const id = uuid(80);
    expect(world.createObject(makeBox(id))).toBe(true);

    expect(world.setMetadata(id, { size: 0 })).toBe(false);
    expect(world.setMetadata(id, { size: 42 })).toBe(false);
    expect(world.setMetadata(id, {})).toBe(false);

    const box = world.getObject(id);
    expect(box).toBeDefined();
    expect((box as BoxObject).size).toBe(1);
    expect(world.count()).toBe(1);
  });

  it("rejects every patch on links", () => {
    const world = makeWorld();
    const id = uuid(81);
    expect(world.createObject(makeLink(id))).toBe(true);
    expect(world.setMetadata(id, { name: "renamed" })).toBe(false);
    expect(world.getObject(id)).toBeDefined();
  });

  it("only allows name on images", () => {
    const world = makeWorld();
    const id = uuid(82);
    expect(world.createObject(makeImage(id))).toBe(true);

    expect(world.setMetadata(id, { stored: true })).toBe(false);
    expect(world.setMetadata(id, { name: "picture.png" })).toBe(true);
    expect((world.getObject(id) as ImageObject).name).toBe("picture.png");
  });

  it("validates file metadata and deletes empty owner/offline", () => {
    const world = makeWorld();
    const id = uuid(83);
    expect(world.createObject(makeFile(id))).toBe(true);

    expect(world.setMetadata(id, { unknown: 1 } as unknown as ObjectMetadataPatch)).toBe(false);
    expect(world.setMetadata(id, { size: -1 })).toBe(false);
    expect(world.setMetadata(id, { stored: "yes" } as unknown as ObjectMetadataPatch)).toBe(false);
    expect(world.setMetadata(id, { owner: "o".repeat(257) })).toBe(false);
    expect(world.setMetadata(id, { name: "n".repeat(MAX_FILE_NAME_LENGTH + 1) })).toBe(false);

    expect(
      world.setMetadata(id, {
        stored: true,
        size: 0,
        category: "audio",
        owner: "bob",
        offline: true,
        name: "renamed.mp3",
      }),
    ).toBe(true);
    expect(world.setMetadata(id, { owner: "", offline: false })).toBe(true);

    const file = world.getObject(id) as FileObject;
    expect(file.stored).toBe(true);
    expect(file.size).toBe(0);
    expect(file.category).toBe("audio");
    expect(file.name).toBe("renamed.mp3");
    expect(file.owner).toBeUndefined();
    expect(file.offline).toBeUndefined();
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

  it("cannot be bypassed by writing false to the deleted map", () => {
    const world = makeWorld();
    const id = uuid(12);
    expect(world.createObject(makeBox(id))).toBe(true);
    expect(world.deleteObject(id)).toBe(true);

    world.doc.getMap<boolean>("deleted").set(id, false);

    expect(world.isDeleted(id)).toBe(true);
    expect(world.getObject(id)).toBeUndefined();
    expect(world.count()).toBe(0);
    expect(world.createObject(makeBox(id))).toBe(false);
    expect(world.moveObject(id, [1, 0, 0], 0)).toBe(false);
    expect(world.setMetadata(id, { size: 1 })).toBe(false);
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

  it("does not move an existing object when a snapshot entry changes kind", () => {
    const world = makeWorld();
    const id = uuid(37);
    expect(world.createObject(makeBox(id, [0, 0, 0]))).toBe(true);

    const conflicting: FileObject = { ...makeFile(id), position: [9, 9, 9] };
    world.mergeFromSnapshot([conflicting]);

    const object = world.getObject(id);
    expect(object).toBeDefined();
    expect(object!.kind).toBe("box");
    expect(object!.position).toEqual([0, 0, 0]);
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

  it("seeds fixed ids so independent replicas converge to five boxes", () => {
    const first = makeWorld("replica-a");
    const second = makeWorld("replica-b");
    seedDemoBoxes(first);
    seedDemoBoxes(second);
    expect(first.count()).toBe(5);
    expect(second.count()).toBe(5);

    const firstUpdate = first.encodeUpdate();
    const secondUpdate = second.encodeUpdate();
    first.applyUpdate(secondUpdate);
    second.applyUpdate(firstUpdate);

    expect(first.count()).toBe(5);
    expect(second.count()).toBe(5);
    expect(first.getObjects().map((object) => object.id)).toEqual(
      second.getObjects().map((object) => object.id),
    );
    expect(first.doc.getMap<unknown>("meta").get("seeded")).toBe("v1");
    expect(second.doc.getMap<unknown>("meta").get("seeded")).toBe("v1");
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
    expect(
      isValidTransform({
        position: [MAX_ABS_POSITION + 1, 0, 0],
        yaw: 0,
        updateId: "u",
        actorId: "a",
        at: 1,
      }),
    ).toBe(false);
    expect(isValidTransform(new Y.Map())).toBe(false);
    expect(isValidTransform({ position: [0, 0, 0], yaw: 0, updateId: "", actorId: "a", at: 1 })).toBe(
      false,
    );
  });

  it("rejects oversized fields and out-of-range positions", () => {
    const world = makeWorld();
    const longUrl = `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`;
    const longName = "n".repeat(MAX_FILE_NAME_LENGTH + 1);
    const longCid = "c".repeat(MAX_CID_LENGTH + 1);

    expect(world.createObject(makeLink(uuid(46), longUrl))).toBe(false);
    expect(world.createObject({ ...makeFile(uuid(47)), name: longName })).toBe(false);
    expect(world.createObject({ ...makeFile(uuid(48)), cid: longCid })).toBe(false);
    expect(world.createObject({ ...makeImage(uuid(49)), cid: longCid })).toBe(false);
    expect(world.createObject(makeBox(uuid(50), [MAX_ABS_POSITION + 1, 0, 0]))).toBe(false);
    expect(world.createObject(makeBox(uuid(51), [0, 0, 0]))).toBe(true);
    expect(world.moveObject(uuid(51), [0, -MAX_ABS_POSITION - 1, 0], 0)).toBe(false);
  });

  it("applies the same caps to peer-written records", () => {
    const world = makeWorld();
    const objects = world.doc.getMap<Y.Map<unknown>>("objects");
    const transform = { position: [0, 0, 0], yaw: 0, updateId: "u", actorId: "a", at: 1 };

    const outOfRange = new Y.Map<unknown>();
    outOfRange.set("kind", "box");
    outOfRange.set("transform", { ...transform, position: [0, MAX_ABS_POSITION + 1, 0] });
    outOfRange.set("size", 1);
    outOfRange.set("color", "#ffffff");
    objects.set(uuid(52), outOfRange);

    const longUrl = new Y.Map<unknown>();
    longUrl.set("kind", "link");
    longUrl.set("transform", transform);
    longUrl.set("url", `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`);
    objects.set(uuid(53), longUrl);

    expect(world.getObject(uuid(52))).toBeUndefined();
    expect(world.getObject(uuid(53))).toBeUndefined();
  });

  it("requires lowercase UUIDs", () => {
    const world = makeWorld();
    const lower = uuid(0xabcdef);
    const upper = lower.toUpperCase();
    expect(lower).not.toBe(upper);
    expect(isValidObjectId(lower)).toBe(true);
    expect(isValidObjectId(upper)).toBe(false);
    expect(world.createObject(makeBox(upper))).toBe(false);
  });
});

describe("same-id concurrent creates", () => {
  it("converges and keeps moves made after the merge", () => {
    const id = uuid(70);
    const first = makeWorld("replica-1");
    const second = makeWorld("replica-2");
    const left = { ...makeBox(id, [1, 0, 0]), size: 2, color: "#111111" };
    const right = { ...makeBox(id, [2, 0, 0]), size: 3, color: "#222222" };

    expect(first.createObject(left)).toBe(true);
    expect(second.createObject(right)).toBe(true);

    const firstUpdate = first.encodeUpdate();
    const secondUpdate = second.encodeUpdate();
    first.applyUpdate(secondUpdate);
    second.applyUpdate(firstUpdate);

    const firstProjection = first.getObject(id);
    const secondProjection = second.getObject(id);
    expect(firstProjection).toBeDefined();
    expect(secondProjection).toBeDefined();
    expect(JSON.stringify(firstProjection)).toBe(JSON.stringify(secondProjection));

    const firstMove = capture(first, () => {
      expect(first.moveObject(id, [7, 8, 9], 0.4, 0.2)).toBe(true);
    });
    for (const update of firstMove) second.applyUpdate(update);
    expect(second.getObject(id)!.position).toEqual([7, 8, 9]);
    expect(second.getObject(id)!.pitch).toBe(0.2);

    const secondMove = capture(second, () => {
      expect(second.moveObject(id, [-1, -2, -3], 0.6)).toBe(true);
    });
    for (const update of secondMove) first.applyUpdate(update);
    expect(first.getObject(id)!.position).toEqual([-1, -2, -3]);
    expect(JSON.stringify(first.getObject(id))).toBe(JSON.stringify(second.getObject(id)));
  });

  it("falls back to the record transform for documents without the transforms map", () => {
    const world = makeWorld();
    const id = uuid(71);
    expect(world.createObject(makeBox(id, [1, 2, 3]))).toBe(true);

    world.doc.getMap("transforms").delete(id);

    expect(world.getObject(id)!.position).toEqual([1, 2, 3]);
  });

  it("prefers a valid shared transform over the record transform", () => {
    const world = makeWorld();
    const id = uuid(72);
    expect(world.createObject(makeBox(id, [1, 2, 3]))).toBe(true);

    const shared: WorldTransform = {
      position: [4, 5, 6],
      yaw: 0.5,
      updateId: "shared",
      actorId: "peer",
      at: 2,
    };
    world.doc.getMap<WorldTransform>("transforms").set(id, shared);

    const object = world.getObject(id)!;
    expect(object.position).toEqual([4, 5, 6]);
    expect(object.yaw).toBe(0.5);
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
