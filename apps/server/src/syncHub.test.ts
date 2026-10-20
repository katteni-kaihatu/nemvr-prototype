import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@proto/protocol";
import { WorldDoc, toBase64 } from "@proto/world-sync";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CLAIM_SEQS_PER_PEER,
  MAX_SYNC_UPDATE_BYTES,
  MAX_SYNC_UPDATE_STRUCTS,
  MAX_WORLD_OBJECTS,
  SyncHub,
  countUpdateStructs,
} from "./syncHub.js";
import { WorldStore, type WorldStoreOptions } from "./worldStore.js";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  closed = false;
  sent: ServerMessage[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }
  clear(): void {
    this.sent = [];
  }
}

const dirs: string[] = [];

async function setup(options: Partial<WorldStoreOptions> = {}): Promise<{
  dir: string;
  store: WorldStore;
  hub: SyncHub;
  a: FakeSocket;
  b: FakeSocket;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "proto-sync-hub-"));
  dirs.push(dir);
  const store = await WorldStore.open({ dir, log: () => {}, ...options });
  const hub = new SyncHub(store, { log: () => {} });
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.attach(a as unknown as WebSocket, "peer-a");
  hub.attach(b as unknown as WebSocket, "peer-b");
  return {
    dir,
    store,
    hub,
    a,
    b,
    cleanup: async () => {
      hub.close();
      await store.flush().catch(() => {});
      store.close();
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a message");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("SyncHub handshake", () => {
  it("sends the missing document as sync_init, marks the peer ready, then ACKs", async () => {
    const { store, hub, a, cleanup } = await setup();
    try {
      const hello = {
        type: "sync_hello" as const,
        worldId: store.worldId,
        schemaVersion: store.syncInfo.schemaVersion,
        stateVector: "",
      };
      expect(hub.handleMessage(a as unknown as WebSocket, hello)).toBe(true);
      expect(hub.isReady(a as unknown as WebSocket)).toBe(true);

      const init = a.of("sync_init");
      const parts = a.of("sync_part");
      expect(init.length + parts.length).toBeGreaterThan(0);
      expect(a.of("sync_ack")).toHaveLength(1);
      expect(a.of("sync_error")).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("rejects a different worldId or schemaVersion and does not mark the peer ready", async () => {
    const { store, hub, cleanup } = await setup();
    try {
      const base = { type: "sync_hello" as const, stateVector: "" };
      const cases: { message: object; pattern: RegExp }[] = [
        { message: { ...base, worldId: "other-world", schemaVersion: 1 }, pattern: /worldId/ },
        { message: { ...base, worldId: store.worldId, schemaVersion: 999 }, pattern: /schemaVersion/ },
        {
          message: { ...base, worldId: store.worldId, schemaVersion: 1, stateVector: "not base64!" },
          pattern: /stateVector/,
        },
      ];
      for (const [index, { message, pattern }] of cases.entries()) {
        const socket = new FakeSocket();
        hub.attach(socket as unknown as WebSocket, `peer-rejected-${index}`);
        hub.handleMessage(socket as unknown as WebSocket, message as never);
        expect(hub.isReady(socket as unknown as WebSocket)).toBe(false);
        expect(socket.of("sync_error")[0]?.message).toMatch(pattern);
        expect(socket.closed).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("rejects sync_update before hello", async () => {
    const { hub, a, cleanup } = await setup();
    try {
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update: "" });
      expect(a.of("sync_error")[0]?.message).toMatch(/sync_hello/);
    } finally {
      await cleanup();
    }
  });
});

describe("SyncHub updates", () => {
  it("applies a peer update, relays it to the other ready peers, and ACKs the sender after saving", async () => {
    const { store, hub, a, b, cleanup } = await setup();
    try {
      for (const socket of [a, b]) {
        hub.handleMessage(socket as unknown as WebSocket, {
          type: "sync_hello",
          worldId: store.worldId,
          schemaVersion: 1,
          stateVector: "",
        });
      }
      a.clear();
      b.clear();

      const id = "123e4567-e89b-42d3-a456-426614174020";
      const producer = new WorldDoc({ actorId: "client" });
      producer.createObject({
        id,
        kind: "box",
        position: [2, 0, 3],
        yaw: 0.25,
        size: 1,
        color: "#aabbcc",
      });
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_update",
        update: toBase64(producer.encodeUpdate()),
      });

      expect(store.world.getObject(id)).toBeDefined();
      expect(b.of("sync_update").length + b.of("sync_part").length).toBeGreaterThan(0);
      expect(a.of("sync_error")).toHaveLength(0);
      await waitFor(() => a.of("sync_ack").length > 0);
      producer.destroy();
    } finally {
      await cleanup();
    }
  });

  it("broadcasts server-originated changes to every ready peer", async () => {
    const { store, hub, a, b, cleanup } = await setup();
    try {
      for (const socket of [a, b]) {
        hub.handleMessage(socket as unknown as WebSocket, {
          type: "sync_hello",
          worldId: store.worldId,
          schemaVersion: 1,
          stateVector: "",
        });
      }
      a.clear();
      b.clear();

      store.world.createObject({
        id: "123e4567-e89b-42d3-a456-426614174021",
        kind: "box",
        position: [0, 0, 0],
        yaw: 0,
        size: 1,
        color: "#d9534f",
      });
      expect(a.of("sync_update").length + a.of("sync_part").length).toBeGreaterThan(0);
      expect(b.of("sync_update").length + b.of("sync_part").length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("reassembles a large update split into sync_part messages", async () => {
    const { store, hub, a, b, cleanup } = await setup();
    try {
      for (const socket of [a, b]) {
        hub.handleMessage(socket as unknown as WebSocket, {
          type: "sync_hello",
          worldId: store.worldId,
          schemaVersion: 1,
          stateVector: "",
        });
      }
      a.clear();
      b.clear();

      const producer = new WorldDoc({ actorId: "client-large" });
      // 有効な長さの名前を持つファイルを多数置き、48 KiB を超える更新を作る
      for (let i = 0; i < 400; i++) {
        producer.createObject({
          id: `123e4567-e89b-42d3-a456-${String(426614170000 + i).padStart(12, "0")}`,
          kind: "file",
          cid: `bafkreilarge${i}`,
          name: `${String(i).padStart(3, "0")}-${"x".repeat(110)}`,
          position: [0, 0, 0],
          yaw: 0,
          size: 1,
          category: "file",
          stored: false,
        });
      }
      const update = producer.encodeUpdate();
      expect(update.length).toBeGreaterThan(48 * 1024);
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update: toBase64(update) });

      expect(b.of("sync_part").length).toBeGreaterThan(1);
      expect(store.world.getObject("123e4567-e89b-42d3-a456-426614170399")).toBeDefined();
      producer.destroy();
    } finally {
      await cleanup();
    }
  });

  it("treats an empty update as a no-op and ACKs the sender", async () => {
    const { store, hub, a, cleanup } = await setup();
    try {
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: store.worldId,
        schemaVersion: 1,
        stateVector: "",
      });
      a.clear();
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update: "" });
      expect(a.of("sync_error")).toHaveLength(0);
      await waitFor(() => a.of("sync_ack").length > 0);
    } finally {
      await cleanup();
    }
  });
});

describe("SyncHub claims", () => {
  it("relays a claim to other ready peers and rejects an until too far in the future", async () => {
    const { store, hub, a, b, cleanup } = await setup();
    try {
      for (const socket of [a, b]) {
        hub.handleMessage(socket as unknown as WebSocket, {
          type: "sync_hello",
          worldId: store.worldId,
          schemaVersion: 1,
          stateVector: "",
        });
      }
      a.clear();
      b.clear();

      const id = "123e4567-e89b-42d3-a456-426614174023";
      hub.handleMessage(a as unknown as WebSocket, {
        type: "claim",
        id,
        sessionId: "session-abcdefgh",
        seq: 1,
        until: Date.now() + 1000,
      });
      expect(b.of("claim")[0]).toMatchObject({ id, peerId: "peer-a", sessionId: "session-abcdefgh", seq: 1 });
      expect(a.of("claim")).toHaveLength(0);

      a.clear();
      hub.handleMessage(a as unknown as WebSocket, {
        type: "claim",
        id,
        sessionId: "session-abcdefgh",
        seq: 2,
        until: Date.now() + 60_000,
      });
      expect(a.of("sync_error")[0]?.message).toMatch(/期限/);
    } finally {
      await cleanup();
    }
  });

  it("turns claim_release into a claim with until 0", async () => {
    const { store, hub, a, b, cleanup } = await setup();
    try {
      for (const socket of [a, b]) {
        hub.handleMessage(socket as unknown as WebSocket, {
          type: "sync_hello",
          worldId: store.worldId,
          schemaVersion: 1,
          stateVector: "",
        });
      }
      a.clear();
      b.clear();
      hub.handleMessage(a as unknown as WebSocket, {
        type: "claim_release",
        id: "123e4567-e89b-42d3-a456-426614174024",
        sessionId: "session-abcdefgh",
      });
      expect(b.of("claim")[0]).toMatchObject({ until: 0, sessionId: "session-abcdefgh" });
    } finally {
      await cleanup();
    }
  });
});

describe("SyncHub hello failure", () => {
  it("closes the socket when a re-hello does not match, instead of leaving it connected but unready", async () => {
    const { store, hub, a, cleanup } = await setup();
    try {
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: store.worldId,
        schemaVersion: 1,
        stateVector: "",
      });
      expect(hub.isReady(a as unknown as WebSocket)).toBe(true);
      expect(a.closed).toBe(false);

      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: "other-world",
        schemaVersion: 1,
        stateVector: "",
      });
      expect(hub.isReady(a as unknown as WebSocket)).toBe(false);
      expect(a.of("sync_error")[0]?.message).toMatch(/worldId/);
      expect(a.closed).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("SyncHub durable ACKs", () => {
  it("does not ACK a failed save, then ACKs with the durable vector after a successful retry", async () => {
    const { dir, store, hub, a, cleanup } = await setup({
      saveDebounceMs: 5,
      saveRetryBaseMs: 10,
      saveRetryMaxMs: 20,
    });
    try {
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: store.worldId,
        schemaVersion: 1,
        stateVector: "",
      });
      a.clear();

      const docPath = join(dir, "doc.bin");
      await rm(docPath);
      await mkdir(docPath); // 保存を失敗させる

      const producer = new WorldDoc({ actorId: "client" });
      const id = "123e4567-e89b-42d3-a456-426614174070";
      producer.createObject({
        id,
        kind: "box",
        position: [1, 0, 0],
        yaw: 0,
        size: 1,
        color: "#aabbcc",
      });
      const update = toBase64(producer.encodeUpdate());
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update });

      await waitFor(() => a.of("sync_error").length > 0);
      expect(a.of("sync_ack")).toHaveLength(0);
      expect(store.hasUnsavedChanges()).toBe(true);

      // 障害を取り除くと、再試行で保存が確定する
      await rm(docPath, { recursive: true, force: true });
      await waitFor(() => !store.hasUnsavedChanges());

      a.clear();
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update });
      await waitFor(() => a.of("sync_ack").length > 0);
      const ack = a.of("sync_ack")[0]!;
      expect(ack.stateVector).toBe(toBase64(store.durableVector()));
      expect(ack.stateVector).toBe(toBase64(store.world.encodeStateVector()));
      producer.destroy();
    } finally {
      await cleanup();
    }
  });
});

describe("SyncHub update limits", () => {
  it("rejects an update over the byte budget before applying it", async () => {
    const { store, hub, a, cleanup } = await setup();
    try {
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: store.worldId,
        schemaVersion: 1,
        stateVector: "",
      });
      a.clear();

      const update = toBase64(new Uint8Array(MAX_SYNC_UPDATE_BYTES + 1));
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update });

      expect(a.of("sync_error")[0]?.message).toMatch(/大きすぎます/);
      expect(store.world.count()).toBe(5);
      expect(a.of("sync_ack")).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("rejects an update with too many structs before applying it", async () => {
    const { store, hub, a, cleanup } = await setup();
    try {
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: store.worldId,
        schemaVersion: 1,
        stateVector: "",
      });
      a.clear();

      const producer = new WorldDoc({ actorId: "client-many-structs" });
      for (let i = 0; i < 2000; i++) {
        producer.createObject({
          id: `123e4567-e89b-42d3-a456-${String(426614180000 + i).padStart(12, "0")}`,
          kind: "box",
          position: [0, 0, 0],
          yaw: 0,
          size: 1,
          color: "#aabbcc",
        });
      }
      const update = producer.encodeUpdate();
      expect(countUpdateStructs(update)).toBeGreaterThan(MAX_SYNC_UPDATE_STRUCTS);

      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update: toBase64(update) });
      expect(a.of("sync_error")[0]?.message).toMatch(/変更が多すぎます/);
      expect(store.world.count()).toBe(5);
      expect(a.of("sync_ack")).toHaveLength(0);
      producer.destroy();
    } finally {
      await cleanup();
    }
  });

  it("blocks further ACKs from a peer that pushes the document over the object cap", async () => {
    const { store, hub, a, cleanup } = await setup();
    try {
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: store.worldId,
        schemaVersion: 1,
        stateVector: "",
      });
      a.clear();

      const producer = new WorldDoc({ actorId: "client-many-objects" });
      for (let i = 0; i < 1001; i++) {
        producer.createObject({
          id: `123e4567-e89b-42d3-a456-${String(426614190000 + i).padStart(12, "0")}`,
          kind: "link",
          url: `https://example.com/${i}`,
          position: [0, 0, 0],
          yaw: 0,
        });
      }
      const update = producer.encodeUpdate();
      expect(countUpdateStructs(update)).toBeLessThanOrEqual(MAX_SYNC_UPDATE_STRUCTS);

      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update: toBase64(update) });
      expect(store.world.count()).toBeGreaterThan(MAX_WORLD_OBJECTS);
      expect(a.of("sync_error")[0]?.message).toMatch(/オブジェクト数/);

      // 上限を超えたピアからの、その後の更新は ACK しない
      a.clear();
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update: "" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(a.of("sync_ack")).toHaveLength(0);
      // オブジェクトは消さない
      expect(store.world.count()).toBeGreaterThan(MAX_WORLD_OBJECTS);
      producer.destroy();
    } finally {
      await cleanup();
    }
  });
});

describe("SyncHub claim bounds", () => {
  it("caps claim state per peer and rejects past-dated claims", async () => {
    const { store, hub, a, cleanup } = await setup();
    try {
      hub.handleMessage(a as unknown as WebSocket, {
        type: "sync_hello",
        worldId: store.worldId,
        schemaVersion: 1,
        stateVector: "",
      });
      a.clear();

      const id = "123e4567-e89b-42d3-a456-426614174080";
      const until = Date.now() + 5_000;
      for (let i = 0; i < MAX_CLAIM_SEQS_PER_PEER + 50; i++) {
        hub.handleMessage(a as unknown as WebSocket, {
          type: "claim",
          id,
          sessionId: `session-${String(i).padStart(8, "0")}`,
          seq: i,
          until,
        });
      }
      expect(hub.claimSeqCount("peer-a")).toBeLessThanOrEqual(MAX_CLAIM_SEQS_PER_PEER);

      a.clear();
      hub.handleMessage(a as unknown as WebSocket, {
        type: "claim",
        id,
        sessionId: "session-past0001",
        seq: 1,
        until: Date.now() - 1_000,
      });
      expect(a.of("sync_error")[0]?.message).toMatch(/期限/);
    } finally {
      await cleanup();
    }
  });
});
