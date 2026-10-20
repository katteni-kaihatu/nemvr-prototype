import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, CrdtSyncInfo, WorldObject } from "@proto/protocol";
import { WorldDoc, encodeTransfer, fromBase64, toBase64 } from "@proto/world-sync";
import { CrdtWorld, openCrdtWorld, type CrdtStatus } from "./crdt";
import type { UpdateStore } from "./idb";

const info: CrdtSyncInfo = { mode: "crdt-v1", worldId: "world-1", schemaVersion: 1 };

interface Harness {
  world: CrdtWorld;
  sent: ClientMessage[];
  projections: Record<string, WorldObject>[];
  statuses: CrdtStatus[];
}

async function makeWorld(overrides: { sessionId?: string; store?: UpdateStore; actorId?: string } = {}): Promise<Harness> {
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
    const source = new WorldDoc({ actorId: "source", now: () => 1 });
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

    const parts = encodeTransfer(source.encodeUpdate(), "update:big");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) receiver.world.handleServerMessage({ type: "sync_part", ...part });

    expect(lastObjects(receiver)[id]?.kind).toBe("image");
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
    const source = new WorldDoc({ actorId: "source" });
    const id = crypto.randomUUID();
    source.createObject({
      id,
      kind: "image",
      cid: "bafy-large",
      position: [0, 0, 0],
      yaw: 0,
      width: 2,
      height: 1,
      name: "x".repeat(60_000),
    });
    h.world.applyPeerUpdate(source.encodeUpdate(), "peer-source");
    h.sent.length = 0;

    h.world.handleServerMessage({ type: "sync_ack", stateVector: "" });
    const parts = h.sent.filter((msg): msg is Extract<ClientMessage, { type: "sync_part" }> => msg.type === "sync_part");
    expect(parts.length).toBeGreaterThan(1);
    expect(lastStatus(h).serverSaved).toBe(false);

    const server = await makeWorld();
    for (const part of parts) server.world.handleServerMessage(part);
    expect(lastObjects(server)[id]?.kind).toBe("image");
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
});
