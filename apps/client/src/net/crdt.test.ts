import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, CrdtSyncInfo, WorldObject } from "@proto/protocol";
import { WorldDoc, encodeTransfer, fromBase64, toBase64 } from "@proto/world-sync";
import { CrdtWorld, openCrdtWorld, type CrdtStatus } from "./crdt";
import { PeerSession, type PeerFrame } from "./crdtP2P";
import type { UpdateStore } from "./idb";

const info: CrdtSyncInfo = { mode: "crdt-v1", worldId: "world-1", schemaVersion: 1 };

interface Harness {
  world: CrdtWorld;
  sent: ClientMessage[];
  projections: Record<string, WorldObject>[];
  statuses: CrdtStatus[];
}

async function makeWorld(
  overrides: { sessionId?: string; store?: UpdateStore; actorId?: string; compactEvery?: number } = {},
): Promise<Harness> {
  const sent: ClientMessage[] = [];
  const projections: Record<string, WorldObject>[] = [];
  const statuses: CrdtStatus[] = [];
  const world = new CrdtWorld(
    info,
    () => "self-peer",
    {
      onObjects: (objects) => projections.push(objects),
      onStatus: (status) => statuses.push(status),
      send: (msg) => {
        sent.push(msg);
        return true;
      },
    },
    {
      actorId: overrides.actorId ?? "actor",
      sessionId: overrides.sessionId ?? "session",
      store: overrides.store,
      compactEvery: overrides.compactEvery,
      now: () => Date.now(),
    },
  );
  await world.init();
  return { world, sent, projections, statuses };
}

function lastObjects(harness: Harness): Record<string, WorldObject> {
  const latest = harness.projections[harness.projections.length - 1];
  if (!latest) throw new Error("no projection");
  return latest;
}

function lastStatus(harness: Harness): CrdtStatus {
  const latest = harness.statuses[harness.statuses.length - 1];
  if (!latest) throw new Error("no status");
  return latest;
}

function updatesOf(harness: Harness): string[] {
  return harness.sent.flatMap((msg) => (msg.type === "sync_update" ? [msg.update] : []));
}

function applyUpdates(target: CrdtWorld, harness: Harness): void {
  for (const update of updatesOf(harness)) target.handleServerMessage({ type: "sync_update", update });
}

/** 48 KiB を超える更新 (分割転送の確認用)。名前の長さ制限に依存せず、更新を重ねて大きくする。 */
function makeLargeSource(): { source: WorldDoc; id: string } {
  const source = new WorldDoc({ actorId: "source" });
  const id = crypto.randomUUID();
  expect(
    source.createObject({
      id,
      kind: "file",
      cid: "bafy-large",
      name: "large.bin",
      size: 1_000_000,
      stored: false,
      category: "file",
      position: [0, 0, 0],
      yaw: 0,
    }),
  ).toBe(true);
  for (let i = 0; i < 5_000; i++) source.moveObject(id, [i % 50, 0, 0], 0);
  expect(source.encodeUpdate().length).toBeGreaterThan(60 * 1024);
  return { source, id };
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CrdtWorld local edits", () => {
  it("creates, moves, duplicates and deletes objects in the projection", async () => {
    const h = await makeWorld();
    const box = h.world.createBox([1, 0, 2]);
    expect(box).toBeDefined();
    expect(lastObjects(h)[box!.id]?.position).toEqual([1, 0, 2]);
    expect(updatesOf(h)).toHaveLength(1);

    h.world.commitMove(box!.id, [5, 0, 0], 0.5, 0.25);
    expect(lastObjects(h)[box!.id]?.position).toEqual([5, 0, 0]);
    expect(lastObjects(h)[box!.id]?.yaw).toBe(0.5);

    const copy = h.world.duplicateObject(box!.id);
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(box!.id);
    expect(Object.keys(lastObjects(h))).toHaveLength(2);
    // ボックスは size + 0.2 横へずらす
    expect(copy!.position[0]).toBeCloseTo(5 + Math.cos(0.5) * 1.2 + Math.sin(0.5) * 0.05);
    expect(copy!.position[2]).toBeCloseTo(0 - Math.sin(0.5) * 1.2 + Math.cos(0.5) * 0.05);

    h.world.deleteObject(box!.id);
    expect(lastObjects(h)[box!.id]).toBeUndefined();
    expect(Object.keys(lastObjects(h))).toEqual([copy!.id]);

    const before = updatesOf(h).length;
    h.world.commitMove(box!.id, [9, 0, 0], 0);
    expect(updatesOf(h)).toHaveLength(before);
  });

  it("does not resurrect an object after a remote tombstone", async () => {
    const a = await makeWorld({ sessionId: "a" });
    const b = await makeWorld({ sessionId: "b" });
    const box = a.world.createBox([0, 0, 0])!;
    applyUpdates(b.world, a);

    a.world.deleteObject(box.id);
    const all = updatesOf(a);
    const createUpdate = all[0]!;
    const deleteUpdate = all[all.length - 1]!;
    b.world.handleServerMessage({ type: "sync_update", update: deleteUpdate });
    expect(lastObjects(b)[box.id]).toBeUndefined();

    // 古い create 更新が削除の後から届いても復活しない
    b.world.handleServerMessage({ type: "sync_update", update: createUpdate });
    expect(lastObjects(b)[box.id]).toBeUndefined();

    const before = updatesOf(b).length;
    b.world.commitMove(box.id, [4, 0, 0], 0);
    expect(updatesOf(b)).toHaveLength(before);
    expect(lastObjects(b)[box.id]).toBeUndefined();
  });

  it("converges three replicas after lossy, duplicated and reordered delivery", async () => {
    const a = await makeWorld({ sessionId: "a", actorId: "actor-a" });
    const b = await makeWorld({ sessionId: "b", actorId: "actor-b" });
    const c = await makeWorld({ sessionId: "c", actorId: "actor-c" });

    const aBox = a.world.createBox([0, 0, 0])!;
    const bBox = b.world.createBox([3, 0, 0])!;
    const cLink = c.world.createLink("https://example.com/", [6, 0, 0], 0)!;
    a.world.commitMove(aBox.id, [1, 0, 0], 0.2);
    b.world.deleteObject(bBox.id);
    c.world.commitMove(cLink.id, [7, 0, 0], 0.4);

    const all = [...updatesOf(a), ...updatesOf(b), ...updatesOf(c)];
    const worlds = [a.world, b.world, c.world];
    const first = shuffle(all, 0x1234);
    for (let i = 0; i < first.length; i++) {
      const update = first[i]!;
      if (i % 4 === 0) continue;
      for (const world of worlds) world.handleServerMessage({ type: "sync_update", update });
      if (i % 3 === 0) {
        for (const world of worlds) world.handleServerMessage({ type: "sync_update", update });
      }
    }
    for (const update of shuffle(all, 0x9999)) {
      for (const world of worlds) world.handleServerMessage({ type: "sync_update", update });
    }

    const canonical = JSON.stringify(lastObjects(a));
    expect(JSON.stringify(lastObjects(b))).toBe(canonical);
    expect(JSON.stringify(lastObjects(c))).toBe(canonical);
    expect(Object.values(lastObjects(a)).map((object) => object.id).sort()).toEqual([aBox.id, cLink.id].sort());
  });
});

describe("CrdtWorld throttled commits", () => {
  it("commits automatic moves at most once per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = await makeWorld();
    const box = h.world.createBox([0, 0, 0])!;
    h.sent.length = 0;

    h.world.moveThrottled(box.id, [1, 0, 0], 0);
    for (let i = 0; i < 10; i++) h.world.moveThrottled(box.id, [i + 2, 0, 0], 0);
    expect(updatesOf(h)).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(updatesOf(h)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(updatesOf(h)).toHaveLength(2);
    expect(lastObjects(h)[box.id]?.position).toEqual([11, 0, 0]);
  });
});

describe("CrdtWorld server messages", () => {
  it("reassembles a large update from sync_part", async () => {
    const receiver = await makeWorld();
    const { source, id } = makeLargeSource();

    const parts = encodeTransfer(source.encodeUpdate(), "update:big");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) receiver.world.handleServerMessage({ type: "sync_part", ...part });

    expect(lastObjects(receiver)[id]?.kind).toBe("file");
  });

  it("sets serverSaved only when the ack state vector matches", async () => {
    const h = await makeWorld();
    expect(lastStatus(h).serverSaved).toBe(false);

    const box = h.world.createBox([0, 0, 0])!;
    h.world.handleServerMessage({ type: "sync_ack", stateVector: h.world.stateVectorBase64() });
    expect(lastStatus(h).serverSaved).toBe(true);

    h.world.handleServerMessage({ type: "sync_ack", stateVector: "AAAAAA==" });
    expect(lastStatus(h).serverSaved).toBe(false);

    h.world.handleServerMessage({ type: "sync_ack", stateVector: h.world.stateVectorBase64() });
    expect(lastStatus(h).serverSaved).toBe(true);
    h.world.commitMove(box.id, [1, 0, 0], 0);
    expect(lastStatus(h).serverSaved).toBe(false);
  });

  it("chunks a large local diff when the acked server vector is empty", async () => {
    const h = await makeWorld();
    const { source, id } = makeLargeSource();
    h.world.applyPeerUpdate(source.encodeUpdate(), "peer-source");
    h.sent.length = 0;

    h.world.handleServerMessage({ type: "sync_ack", stateVector: "" });
    const parts = h.sent.filter((msg): msg is Extract<ClientMessage, { type: "sync_part" }> => msg.type === "sync_part");
    expect(parts.length).toBeGreaterThan(1);
    expect(lastStatus(h).serverSaved).toBe(false);

    const server = await makeWorld();
    for (const part of parts) server.world.handleServerMessage(part);
    expect(lastObjects(server)[id]?.kind).toBe("file");
  });

  it("sends the local diff when a stale server vector is acknowledged", async () => {
    const store = new CountingStore();
    const h = await makeWorld({ store });
    const box = h.world.createBox([0, 0, 0])!;
    // ローカルの作成は、まだサーバーに届いていない状態にする
    h.sent.length = 0;

    // 空の state vector = サーバーは何も持っていない。ローカルの更新を送り返す必要がある
    h.world.handleServerMessage({ type: "sync_ack", stateVector: "" });
    const sentUpdates = h.sent.filter(
      (msg): msg is Extract<ClientMessage, { type: "sync_update" }> => msg.type === "sync_update",
    );
    expect(sentUpdates.length).toBeGreaterThan(0);
    expect(lastStatus(h).serverSaved).toBe(false);

    const serverView = new WorldDoc({ actorId: "server" });
    for (const msg of sentUpdates) {
      const update = fromBase64(msg.update);
      expect(update).not.toBeNull();
      serverView.applyUpdate(update!);
    }
    expect(serverView.getObject(box.id)).toBeDefined();

    // サーバーが追い付いた vector の ACK では、もう更新を送らない
    h.sent.length = 0;
    h.world.handleServerMessage({ type: "sync_ack", stateVector: h.world.getStateVectorBase64() });
    expect(h.sent.filter((msg) => msg.type === "sync_update" || msg.type === "sync_part")).toHaveLength(0);
    expect(lastStatus(h).serverSaved).toBe(true);
  });

  it("does not answer an ack when the vectors already match (delete-set-only diff)", async () => {
    const h = await makeWorld();
    const keep = h.world.createBox([0, 0, 0])!;
    const removed = h.world.createBox([2, 0, 0])!;
    h.world.commitMove(keep.id, [1, 0, 0], 0);
    h.world.deleteObject(removed.id);
    await h.world.flush();
    h.sent.length = 0;

    // 削除は state vector を進めない。同じ vector の ack で delete set を送り返してはいけない
    const vector = h.world.getStateVectorBase64();
    for (let i = 0; i < 5; i++) h.world.handleServerMessage({ type: "sync_ack", stateVector: vector });

    expect(h.sent.filter((msg) => msg.type === "sync_update" || msg.type === "sync_part")).toHaveLength(0);
    expect(lastStatus(h).serverSaved).toBe(true);
  });

  it("reports a fatal sync error in the status", async () => {
    const h = await makeWorld();
    h.world.handleServerMessage({ type: "sync_error", message: "worldId mismatch" });
    expect(lastStatus(h).sync).toBe("sync-error");
  });
});

describe("CrdtWorld remote deletes", () => {
  it("stops a local grab and heartbeat when the object is deleted remotely", async () => {
    const h = await makeWorld({ sessionId: "self-session" });
    const remote = await makeWorld({ sessionId: "remote-session", actorId: "remote-actor" });
    const box = remote.world.createBox([0, 0, 0])!;
    applyUpdates(h.world, remote);
    expect(lastObjects(h)[box.id]).toBeDefined();

    vi.useFakeTimers();
    vi.setSystemTime(0);
    h.sent.length = 0;
    h.world.startGrab(box.id);
    expect(h.sent.filter((msg) => msg.type === "claim")).toHaveLength(1);

    remote.world.deleteObject(box.id);
    const deleted = updatesOf(remote).at(-1)!;
    h.world.handleServerMessage({ type: "sync_update", update: deleted });
    expect(lastObjects(h)[box.id]).toBeUndefined();

    // 消えた ID への claim を送り続けない
    h.sent.length = 0;
    vi.advanceTimersByTime(3_000);
    expect(h.sent.filter((msg) => msg.type === "claim")).toHaveLength(0);
  });
});

describe("CrdtWorld claims", () => {
  it("deduplicates the same claim arriving over WS and P2P", async () => {
    const h = await makeWorld({ sessionId: "self-session" });
    const box = h.world.createBox([0, 0, 0])!;
    const until = Date.now() + 10_000;

    h.world.handleServerMessage({
      type: "claim",
      id: box.id,
      peerId: "ws-peer",
      sessionId: "remote-session",
      seq: 1,
      until,
    });
    expect(lastObjects(h)[box.id]?.heldBy).toBe("ws-peer");

    // 同じ session の claim が P2P からも届く (peerId は libp2p の ID)
    const frames: PeerFrame[] = [];
    const session = new PeerSession({
      peerId: "p2p-peer",
      sendFrame: (frame) => frames.push(frame),
      applyUpdate: () => {},
      getHello: () => ({
        worldId: info.worldId,
        schemaVersion: info.schemaVersion,
        vector: h.world.getStateVectorBase64(),
      }),
      diffFor: () => new Uint8Array(0),
      onClaim: (msg) => h.world.handleServerMessage(msg),
    });
    session.sendClaim({ id: box.id, sessionId: "remote-session", seq: 1, until });

    // 片方の経路の release で消える (二重に登録されていれば残ってしまう)
    h.world.handleServerMessage({
      type: "claim",
      id: box.id,
      peerId: "ws-peer",
      sessionId: "remote-session",
      seq: 2,
      until: 0,
    });
    expect(lastObjects(h)[box.id]?.heldBy).toBeUndefined();
  });

  it("ignores claims from its own session", async () => {
    const h = await makeWorld({ sessionId: "self-session" });
    const box = h.world.createBox([0, 0, 0])!;
    h.world.handleServerMessage({
      type: "claim",
      id: box.id,
      peerId: "someone-else",
      sessionId: "self-session",
      seq: 1,
      until: Date.now() + 10_000,
    });
    expect(lastObjects(h)[box.id]?.heldBy).toBeUndefined();
  });
});

describe("CrdtWorld P2P transport", () => {
  it("reports p2p while the websocket is offline with a live peer", async () => {
    const h = await makeWorld();
    h.world.notifyTransport(false);
    expect(lastStatus(h).sync).toBe("offline");

    h.world.setPeerCount(1);
    h.world.markP2PAvailable(true);
    expect(lastStatus(h).sync).toBe("p2p");
    expect(lastStatus(h).serverSaved).toBe(false);

    h.world.setPeerCount(0);
    h.world.markP2PAvailable(false);
    expect(lastStatus(h).sync).toBe("offline");

    h.world.notifyTransport(true);
    h.world.handleServerMessage({ type: "sync_ack", stateVector: h.world.getStateVectorBase64() });
    h.world.setPeerCount(1);
    h.world.markP2PAvailable(true);
    expect(lastStatus(h).sync).toBe("online");
  });

  it("persists a peer update, relays it to the server and to other peers (not the sender)", async () => {
    const store = new CountingStore();
    const sent: ClientMessage[] = [];
    const projections: Record<string, WorldObject>[] = [];
    const statuses: CrdtStatus[] = [];
    const world = new CrdtWorld(
      info,
      () => "self-peer",
      {
        onObjects: (objects) => projections.push(objects),
        onStatus: (status) => statuses.push(status),
        send: (msg) => {
          sent.push(msg);
          return true;
        },
      },
      { actorId: "actor", sessionId: "session", store },
    );
    await world.init();

    const relays: { update: Uint8Array; exceptPeerId?: string }[] = [];
    const ephemeral: ClientMessage[] = [];
    world.setPeerTransport({
      send: (update, exceptPeerId) => relays.push({ update, exceptPeerId }),
      sendEphemeral: (msg) => ephemeral.push(msg),
    });

    const source = new WorldDoc({ actorId: "source", now: () => 1 });
    const id = crypto.randomUUID();
    expect(
      source.createObject({ id, kind: "box", position: [0, 0, 0], yaw: 0, size: 1, color: "#d9534f" }),
    ).toBe(true);
    sent.length = 0;
    world.applyPeerUpdate(source.encodeUpdate(), "peer-a");
    await world.flush();

    expect(projections[projections.length - 1]?.[id]).toBeDefined();
    expect(store.appends).toHaveLength(1);
    expect(statuses[statuses.length - 1]?.serverSaved).toBe(false);
    expect(sent.some((msg) => msg.type === "sync_update")).toBe(true);
    expect(relays).toHaveLength(1);
    expect(relays[0]?.exceptPeerId).toBe("peer-a");

    // サーバーから来た更新はエコーしない
    sent.length = 0;
    world.handleServerMessage({ type: "sync_update", update: toBase64(source.encodeUpdate()) });
    expect(relays).toHaveLength(1);

    // サーバーから来た新しい更新は、エコーしないがローカルには保存する (オフライン再読み込み用)
    const fresh = new WorldDoc({ actorId: "source", now: () => 2 });
    const freshId = crypto.randomUUID();
    expect(
      fresh.createObject({
        id: freshId,
        kind: "box",
        position: [2, 0, 0],
        yaw: 0,
        size: 1,
        color: "#5bc0de",
      }),
    ).toBe(true);
    const appendsBefore = store.appends.length;
    world.handleServerMessage({ type: "sync_update", update: toBase64(fresh.encodeUpdate()) });
    await world.flush();
    expect(projections[projections.length - 1]?.[freshId]).toBeDefined();
    expect(store.appends).toHaveLength(appendsBefore + 1);
    expect(sent.filter((msg) => msg.type === "sync_update" || msg.type === "sync_part")).toHaveLength(0);
    expect(relays).toHaveLength(1);

    // claim は WS と P2P の両方へ
    sent.length = 0;
    world.startGrab(id);
    expect(sent.some((msg) => msg.type === "claim")).toBe(true);
    expect(ephemeral.some((msg) => msg.type === "claim")).toBe(true);
    world.endGrab(id);
    expect(sent.some((msg) => msg.type === "claim_release")).toBe(true);
    expect(ephemeral.some((msg) => msg.type === "claim_release")).toBe(true);
  });
});

class CountingStore implements UpdateStore {
  appends: Uint8Array[] = [];
  compacts: Uint8Array[] = [];

  async load(): Promise<Uint8Array[]> {
    return [];
  }

  async append(update: Uint8Array): Promise<void> {
    this.appends.push(new Uint8Array(update));
  }

  async compact(snapshot: Uint8Array): Promise<void> {
    this.compacts.push(new Uint8Array(snapshot));
  }

  close(): void {
    // 何もしない
  }
}

describe("CrdtWorld persistence", () => {
  it("falls back to memory and reports save-failed when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const statuses: CrdtStatus[] = [];
    const world = await openCrdtWorld(info, () => "self-peer", {
      onObjects: () => {},
      onStatus: (status) => statuses.push(status),
      send: () => false,
    });

    const status = statuses[statuses.length - 1];
    expect(status?.sync).toBe("save-failed");
    expect(status?.localSaved).toBe(false);
    expect(world.createBox([0, 0, 0])).toBeDefined();
    await world.close();
  });

  it("appends local updates and compacts the log", async () => {
    const store = new CountingStore();
    const statuses: CrdtStatus[] = [];
    const world = new CrdtWorld(
      info,
      () => "self-peer",
      {
        onObjects: () => {},
        onStatus: (status) => statuses.push(status),
        send: () => true,
      },
      { actorId: "actor", sessionId: "session", store, compactEvery: 2, compactBytes: Number.MAX_SAFE_INTEGER },
    );
    await world.init();
    expect(statuses[statuses.length - 1]?.localSaved).toBe(true);

    world.createBox([0, 0, 0]);
    world.createBox([1, 0, 0]);
    await world.flush();

    expect(store.appends).toHaveLength(2);
    expect(store.compacts).toHaveLength(1);
    expect((await world.flush(), store.compacts[0]?.length ?? 0)).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]?.localSaved).toBe(true);
  });

  it("recovers from a failed append with a full snapshot", async () => {
    const store = new ScriptedStore();
    store.appendError = new Error("append failed");
    const h = await makeWorld({ store });
    h.world.createBox([0, 0, 0]);
    await h.world.flush();

    expect(store.compacts).toHaveLength(1);
    expect(store.appends).toHaveLength(0);
    expect(lastStatus(h).sync).not.toBe("save-failed");
    expect(lastStatus(h).localSaved).toBe(true);
  });

  it("does not treat a compaction failure as a permanent save failure", async () => {
    const store = new ScriptedStore();
    store.compactError = new Error("compact failed");
    const h = await makeWorld({ store, compactEvery: 1 });
    const before = h.sent.length;
    h.world.createBox([0, 0, 0]);
    await h.world.flush();

    expect(store.appends).toHaveLength(1);
    expect(lastStatus(h).sync).not.toBe("save-failed");
    expect(lastStatus(h).localSaved).toBe(true);
    expect(h.sent.length).toBeGreaterThanOrEqual(before);
  });

  it("skips a corrupt row and keeps loading later valid rows", async () => {
    const first = new WorldDoc({ actorId: "first" });
    const second = new WorldDoc({ actorId: "second" });
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    expect(
      first.createObject({ id: firstId, kind: "box", position: [0, 0, 0], yaw: 0, size: 1, color: "#d9534f" }),
    ).toBe(true);
    expect(
      second.createObject({ id: secondId, kind: "box", position: [1, 0, 0], yaw: 0, size: 1, color: "#5bc0de" }),
    ).toBe(true);

    const store = new ScriptedStore();
    store.loaded = [first.encodeUpdate(), new Uint8Array([255, 255, 255]), second.encodeUpdate()];
    const h = await makeWorld({ store });

    expect(lastObjects(h)[firstId]).toBeDefined();
    expect(lastObjects(h)[secondId]).toBeDefined();
    expect(lastStatus(h).sync).not.toBe("save-failed");
    expect(lastStatus(h).localSaved).toBe(true);
    // 壊れた行を飛ばした直後は圧縮しない (残りの行を消さない)
    expect(store.compacts).toHaveLength(0);
  });
});

class ScriptedStore implements UpdateStore {
  loaded: Uint8Array[] = [];
  appends: Uint8Array[] = [];
  compacts: Uint8Array[] = [];
  appendError: Error | null = null;
  compactError: Error | null = null;

  async load(): Promise<Uint8Array[]> {
    return this.loaded.map((update) => new Uint8Array(update));
  }

  async append(update: Uint8Array): Promise<void> {
    if (this.appendError) throw this.appendError;
    this.appends.push(new Uint8Array(update));
  }

  async compact(
    snapshot: Uint8Array,
    merge?: (snapshot: Uint8Array, existing: Uint8Array[]) => Uint8Array,
  ): Promise<void> {
    if (this.compactError) throw this.compactError;
    this.compacts.push(merge ? merge(snapshot, this.appends) : new Uint8Array(snapshot));
  }

  close(): void {
    // 何もしない
  }
}
