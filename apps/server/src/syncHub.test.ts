import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@proto/protocol";
import { WorldDoc, toBase64 } from "@proto/world-sync";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { SyncHub } from "./syncHub.js";
import { WorldStore } from "./worldStore.js";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }
  clear(): void {
    this.sent = [];
  }
}

const dirs: string[] = [];

async function setup(): Promise<{
  store: WorldStore;
  hub: SyncHub;
  a: FakeSocket;
  b: FakeSocket;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "proto-sync-hub-"));
  dirs.push(dir);
  const store = await WorldStore.open({ dir, log: () => {} });
  const hub = new SyncHub(store, { log: () => {} });
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.attach(a as unknown as WebSocket, "peer-a");
  hub.attach(b as unknown as WebSocket, "peer-b");
  return {
    store,
    hub,
    a,
    b,
    cleanup: async () => {
      hub.close();
      await store.flush();
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
    const { store, hub, a, cleanup } = await setup();
    try {
      const base = { type: "sync_hello" as const, stateVector: "" };
      hub.handleMessage(a as unknown as WebSocket, { ...base, worldId: "other-world", schemaVersion: 1 });
      expect(hub.isReady(a as unknown as WebSocket)).toBe(false);
      expect(a.of("sync_error")[0]?.message).toMatch(/worldId/);

      a.clear();
      hub.handleMessage(a as unknown as WebSocket, { ...base, worldId: store.worldId, schemaVersion: 999 });
      expect(hub.isReady(a as unknown as WebSocket)).toBe(false);
      expect(a.of("sync_error")[0]?.message).toMatch(/schemaVersion/);

      a.clear();
      hub.handleMessage(a as unknown as WebSocket, { ...base, worldId: store.worldId, schemaVersion: 1, stateVector: "not base64!" });
      expect(hub.isReady(a as unknown as WebSocket)).toBe(false);
      expect(a.of("sync_error")[0]?.message).toMatch(/stateVector/);
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
      // 大きめの名前 (ファイルオブジェクト) で、48 KiB を超える更新を作る
      const id = "123e4567-e89b-42d3-a456-426614174022";
      producer.createObject({
        id,
        kind: "file",
        cid: "bafkreilarge",
        name: "x".repeat(120_000),
        position: [0, 0, 0],
        yaw: 0,
        size: 1,
        category: "file",
        stored: false,
      });
      const update = producer.encodeUpdate();
      expect(update.length).toBeGreaterThan(48 * 1024);
      hub.handleMessage(a as unknown as WebSocket, { type: "sync_update", update: toBase64(update) });

      expect(b.of("sync_part").length).toBeGreaterThan(1);
      expect(store.world.getObject(id)).toBeDefined();
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
