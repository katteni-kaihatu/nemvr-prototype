import { describe, expect, it } from "vitest";
import type { ClientMessage, CrdtSyncInfo, WorldObject } from "@proto/protocol";
import { WorldDoc, toBase64 } from "@proto/world-sync";
import { CrdtWorld, type CrdtStatus } from "./crdt";
import {
  MAX_PEER_FRAME_BYTES,
  PeerFrameDecoder,
  PeerSession,
  encodePeerFrame,
  type PeerFrame,
} from "./crdtP2P";

const info: CrdtSyncInfo = { mode: "crdt-v1", worldId: "world-1", schemaVersion: 1 };

interface Harness {
  world: CrdtWorld;
  sent: ClientMessage[];
  statuses: CrdtStatus[];
  projections: Record<string, WorldObject>[];
  clock: { now: number };
}

async function makeWorld(name: string): Promise<Harness> {
  const sent: ClientMessage[] = [];
  const statuses: CrdtStatus[] = [];
  const projections: Record<string, WorldObject>[] = [];
  const clock = { now: 1_000_000 };
  const world = new CrdtWorld(
    info,
    () => `self-${name}`,
    {
      onObjects: (objects) => projections.push(objects),
      onStatus: (status) => statuses.push(status),
      send: (msg) => {
        sent.push(msg);
        return true;
      },
    },
    { actorId: `actor-${name}`, sessionId: `session-${name}`, now: () => clock.now },
  );
  await world.init();
  return { world, sent, statuses, projections, clock };
}

function lastObjects(h: Harness): Record<string, WorldObject> {
  const latest = h.projections[h.projections.length - 1];
  if (!latest) throw new Error("no projection");
  return latest;
}

function hello(h: Harness): { worldId: string; schemaVersion: number; vector: string } {
  return {
    worldId: h.world.info.worldId,
    schemaVersion: h.world.info.schemaVersion,
    vector: h.world.getStateVectorBase64(),
  };
}

interface Wire {
  peer: PeerSession | null;
  frames: PeerFrame[];
  receive(frame: PeerFrame): void;
}

function wire(): Wire {
  const w: Wire = {
    peer: null,
    frames: [],
    receive(frame) {
      w.frames.push(frame);
      w.peer?.receive(frame);
    },
  };
  return w;
}

function connect(
  a: Harness,
  b: Harness,
  options: { start?: boolean } = {},
): { aSession: PeerSession; bSession: PeerSession; wireA: Wire; wireB: Wire } {
  const wireA = wire();
  const wireB = wire();
  const aSession = new PeerSession({
    peerId: "peer-b",
    sendFrame: (frame) => wireB.receive(frame),
    applyUpdate: (update) => a.world.applyPeerUpdate(update, "peer-b"),
    getHello: () => hello(a),
    diffFor: (vector) => a.world.encodeLocalDiffForRemote(vector),
    onClaim: (msg) => a.world.handleServerMessage(msg),
  });
  const bSession = new PeerSession({
    peerId: "peer-a",
    sendFrame: (frame) => wireA.receive(frame),
    applyUpdate: (update) => b.world.applyPeerUpdate(update, "peer-a"),
    getHello: () => hello(b),
    diffFor: (vector) => b.world.encodeLocalDiffForRemote(vector),
    onClaim: (msg) => b.world.handleServerMessage(msg),
  });
  wireA.peer = aSession;
  wireB.peer = bSession;
  if (options.start !== false) {
    aSession.start();
    bSession.start();
  }
  return { aSession, bSession, wireA, wireB };
}

function fullUpdate(h: Harness): string {
  return toBase64(h.world.encodeLocalDiffForRemote(new Uint8Array(0)));
}

describe("peer frame codec", () => {
  const frames: PeerFrame[] = [
    { t: "hello", worldId: "w", schemaVersion: 1, vector: "AAAA" },
    { t: "init", update: "AAAA" },
    { t: "update", update: "BBBB" },
    { t: "part", transferId: "p2p:x", index: 1, count: 3, data: "CCCC" },
    { t: "ack", vector: "DDDD" },
    { t: "claim", id: "obj", sessionId: "s", seq: 2, until: 1234 },
    { t: "claim_release", id: "obj", sessionId: "s" },
    { t: "error", message: "nope" },
  ];

  it("roundtrips every frame type", () => {
    for (const frame of frames) {
      const decoder = new PeerFrameDecoder();
      expect(decoder.push(encodePeerFrame(frame))).toEqual([frame]);
    }
  });

  it("reassembles a frame split at every byte boundary", () => {
    const frame: PeerFrame = { t: "hello", worldId: "w", schemaVersion: 1, vector: "AAAA" };
    const bytes = encodePeerFrame(frame);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new PeerFrameDecoder();
      const first = decoder.push(bytes.subarray(0, split));
      const second = decoder.push(bytes.subarray(split));
      expect([...first, ...second]).toEqual([frame]);
    }
  });

  it("decodes multiple frames in one chunk", () => {
    const first: PeerFrame = { t: "update", update: "AAAA" };
    const second: PeerFrame = { t: "ack", vector: "BBBB" };
    const a = encodePeerFrame(first);
    const b = encodePeerFrame(second);
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    const decoder = new PeerFrameDecoder();
    expect(decoder.push(both)).toEqual([first, second]);
  });

  it("rejects zero, oversized and invalid-JSON frames", () => {
    const zero = new Uint8Array(4);
    expect(() => new PeerFrameDecoder().push(zero)).toThrow();

    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, MAX_PEER_FRAME_BYTES + 1, false);
    expect(() => new PeerFrameDecoder().push(oversized)).toThrow();

    const invalid = new Uint8Array(4 + 3);
    new DataView(invalid.buffer).setUint32(0, 3, false);
    invalid.set([0x6e, 0x6f, 0x70], 4); // "nop"
    expect(() => new PeerFrameDecoder().push(invalid)).toThrow();
  });
});

describe("PeerSession", () => {
  it("chunks a large update and reassembles it", async () => {
    const a = await makeWorld("a");
    const b = await makeWorld("b");
    const source = new WorldDoc({ actorId: "source" });
    const id = crypto.randomUUID();
    expect(
      source.createObject({
        id,
        kind: "image",
        cid: "bafy-large",
        position: [0, 0, 0],
        yaw: 0,
        width: 2,
        height: 1,
        name: "x".repeat(60_000),
      }),
    ).toBe(true);
    a.world.applyPeerUpdate(source.encodeUpdate(), "peer-source");

    const { wireB } = connect(a, b);
    expect(wireB.frames.some((frame) => frame.t === "part")).toBe(true);
    expect(lastObjects(b)[id]?.kind).toBe("image");
  });

  it("converges two replicas in both directions after hello/init/ack", async () => {
    const a = await makeWorld("a");
    const b = await makeWorld("b");
    const aBox = a.world.createBox([1, 0, 0])!;
    const bBox = b.world.createBox([2, 0, 0])!;

    connect(a, b);

    expect(lastObjects(a)[bBox.id]?.position).toEqual([2, 0, 0]);
    expect(lastObjects(b)[aBox.id]?.position).toEqual([1, 0, 0]);
    expect(JSON.stringify(lastObjects(a))).toBe(JSON.stringify(lastObjects(b)));
  });

  it("converges offline edits from both sides after reconnect", async () => {
    const a = await makeWorld("a");
    const b = await makeWorld("b");
    const aBox = a.world.createBox([1, 0, 0])!;
    const bBox = b.world.createBox([2, 0, 0])!;

    // 接続が無い間に両側で編集する
    a.world.commitMove(aBox.id, [10, 0, 0], 0.5);
    b.world.deleteObject(bBox.id);

    connect(a, b);

    const objects = lastObjects(b);
    expect(objects[aBox.id]?.position).toEqual([10, 0, 0]);
    expect(objects[bBox.id]).toBeUndefined();
    expect(JSON.stringify(lastObjects(a))).toBe(JSON.stringify(lastObjects(b)));
  });

  it("treats duplicate and out-of-order updates as harmless", async () => {
    const a = await makeWorld("a");
    const b = await makeWorld("b");
    const box = a.world.createBox([0, 0, 0])!;
    const createUpdate = fullUpdate(a);
    const beforeDelete = a.world.stateVector();
    a.world.deleteObject(box.id);
    const deleteUpdate = toBase64(a.world.encodeLocalDiffForRemote(beforeDelete));

    const wireA = wire();
    const session = new PeerSession({
      peerId: "peer-a",
      sendFrame: (frame) => wireA.receive(frame),
      applyUpdate: (update) => b.world.applyPeerUpdate(update, "peer-a"),
      getHello: () => hello(b),
      diffFor: (vector) => b.world.encodeLocalDiffForRemote(vector),
    });

    session.receive({ t: "update", update: deleteUpdate });
    session.receive({ t: "update", update: createUpdate });
    session.receive({ t: "update", update: createUpdate });
    expect(lastObjects(b)[box.id]).toBeUndefined();
  });

  it("delivers claims and releases with expiration semantics", async () => {
    const a = await makeWorld("a");
    const b = await makeWorld("b");
    const box = a.world.createBox([0, 0, 0])!;
    const { aSession } = connect(a, b);

    aSession.sendClaim({ id: box.id, sessionId: "session-a", seq: 1, until: b.clock.now + 1_000 });
    expect(lastObjects(b)[box.id]?.heldBy).toBe("peer-a");

    // 期限が切れたら表示から消える (受信側の時計で判定)
    b.clock.now += 2_000;
    b.world.commitMove(box.id, [1, 0, 0], 0);
    expect(lastObjects(b)[box.id]?.heldBy).toBeUndefined();

    // 再び claim してから release すると、期限を待たずに消える
    aSession.sendClaim({ id: box.id, sessionId: "session-a", seq: 2, until: b.clock.now + 1_000 });
    expect(lastObjects(b)[box.id]?.heldBy).toBe("peer-a");
    aSession.sendClaimRelease(box.id, "session-a");
    expect(lastObjects(b)[box.id]?.heldBy).toBeUndefined();
  });

  it("does not throw on malformed frames or invalid base64", async () => {
    const a = await makeWorld("a");
    const session = new PeerSession({
      peerId: "peer-b",
      sendFrame: () => {},
      applyUpdate: () => {},
      getHello: () => hello(a),
      diffFor: () => new Uint8Array(0),
    });

    expect(() => session.receive({ t: "nope" } as unknown as PeerFrame)).not.toThrow();
    expect(() => session.receive({ t: "update", update: "!!!not-base64" })).not.toThrow();
    expect(() => session.receive({ t: "part", transferId: "x", index: 0, count: 1, data: "!!!" })).not.toThrow();
    expect(() => session.receive({ t: "part", transferId: "x", index: 9, count: 2, data: "AAAA" })).not.toThrow();
    expect(() => session.receive({ t: "ack", vector: "!!!" })).not.toThrow();
  });

  it("rejects a different world or schema without throwing", async () => {
    const a = await makeWorld("a");
    const errors: string[] = [];
    const frames: PeerFrame[] = [];
    const session = new PeerSession({
      peerId: "peer-b",
      sendFrame: (frame) => frames.push(frame),
      applyUpdate: () => {},
      getHello: () => hello(a),
      diffFor: () => new Uint8Array(0),
      onError: (message) => errors.push(message),
    });

    expect(() =>
      session.receive({ t: "hello", worldId: "other", schemaVersion: 1, vector: "" }),
    ).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(frames.some((frame) => frame.t === "error")).toBe(true);
    expect(session.isClosed).toBe(true);
  });
});
