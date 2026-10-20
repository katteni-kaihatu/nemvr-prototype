import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldDoc } from "@proto/world-sync";
import { afterEach, describe, expect, it } from "vitest";
import { WorldStore } from "./worldStore.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "proto-world-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("WorldStore", () => {
  it("creates a world, seeds five demo boxes once, and persists meta and the document", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    try {
      expect(store.worldId).toMatch(/^[0-9a-f-]{36}$/);
      expect(store.syncInfo).toEqual({ mode: "crdt-v1", worldId: store.worldId, schemaVersion: 1 });
      expect(store.world.getObjects()).toHaveLength(5);
      expect(store.world.getObjects().every((object) => object.kind === "box")).toBe(true);

      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(meta.worldId).toBe(store.worldId);
      expect(meta.schemaVersion).toBe(1);
      expect(typeof meta.createdAt).toBe("string");
      expect((await readFile(join(dir, "doc.bin"))).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("reopens the same worldId and objects without seeding again", async () => {
    const dir = await tempDir();
    const first = await WorldStore.open({ dir, log: () => {} });
    const worldId = first.worldId;
    const ids = first.world.getObjects().map((object) => object.id).sort();
    first.close();

    const second = await WorldStore.open({ dir, log: () => {} });
    try {
      expect(second.worldId).toBe(worldId);
      expect(second.world.getObjects().map((object) => object.id).sort()).toEqual(ids);
      expect(second.world.getObjects()).toHaveLength(5);
    } finally {
      second.close();
    }

    const third = await WorldStore.open({ dir, log: () => {} });
    try {
      expect(third.world.getObjects()).toHaveLength(5);
    } finally {
      third.close();
    }
  });

  it("resolves scheduleSave after the current state is durable, and coalesces concurrent calls", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    const object = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      kind: "box" as const,
      position: [1, 2, 3] as [number, number, number],
      yaw: 0.5,
      size: 2,
      color: "#aabbcc",
    };
    expect(store.world.createObject(object)).toBe(true);
    await Promise.all([store.scheduleSave(), store.scheduleSave(), store.scheduleSave()]);
    store.close();

    const reopened = await WorldStore.open({ dir, log: () => {} });
    try {
      expect(reopened.world.getObject(object.id)).toMatchObject({ kind: "box", position: [1, 2, 3] });
    } finally {
      reopened.close();
    }
  });

  it("flush writes the latest state even without a debounce wait", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    const id = "123e4567-e89b-42d3-a456-426614174001";
    store.world.createObject({
      id,
      kind: "box",
      position: [4, 0, 4],
      yaw: 0,
      size: 1,
      color: "#d9534f",
    });
    await store.flush();
    store.close();

    const reopened = await WorldStore.open({ dir, log: () => {} });
    try {
      expect(reopened.world.getObject(id)).toBeDefined();
      expect(reopened.fileObjects()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("throws on a corrupt doc.bin instead of creating an empty world", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    store.close();
    await writeFile(join(dir, "doc.bin"), "this is not a yjs update");

    await expect(WorldStore.open({ dir, log: () => {} })).rejects.toThrow(/壊れています/);
  });

  it("throws when doc.bin is a valid but uninitialized (empty) Yjs document", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    store.close();
    const empty = new WorldDoc({ actorId: "empty" });
    await writeFile(join(dir, "doc.bin"), empty.encodeUpdate());
    empty.destroy();

    await expect(WorldStore.open({ dir, log: () => {} })).rejects.toThrow(/初期化済み/);
  });

  it("throws on a corrupt meta.json", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    store.close();
    await writeFile(join(dir, "meta.json"), "{not json");

    await expect(WorldStore.open({ dir, log: () => {} })).rejects.toThrow(/壊れています/);
  });

  it("throws on a schema mismatch", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    store.close();
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    meta.schemaVersion = 999;
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta));

    await expect(WorldStore.open({ dir, log: () => {} })).rejects.toThrow(/schemaVersion/);
  });

  it("throws when only one of meta.json / doc.bin exists", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    store.close();
    await rm(join(dir, "doc.bin"));

    await expect(WorldStore.open({ dir, log: () => {} })).rejects.toThrow(/不完全/);
  });

  it("does not initialize a new world when both files are missing but the directory is not empty", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "content.json"), "{}");

    await expect(WorldStore.open({ dir, log: () => {} })).rejects.toThrow(/見つかりません/);
  });

  it("findFileByCid only returns stored files", async () => {
    const dir = await tempDir();
    const store = await WorldStore.open({ dir, log: () => {} });
    try {
      const storedId = "123e4567-e89b-42d3-a456-426614174010";
      const pendingId = "123e4567-e89b-42d3-a456-426614174011";
      expect(
        store.world.createObject({
          id: storedId,
          kind: "file",
          cid: "bafkreistored",
          name: "a.txt",
          position: [0, 0, 0],
          yaw: 0,
          size: 10,
          category: "file",
          stored: true,
        }),
      ).toBe(true);
      expect(
        store.world.createObject({
          id: pendingId,
          kind: "file",
          cid: "bafkreipending",
          name: "b.txt",
          position: [0, 0, 0],
          yaw: 0,
          size: 10,
          category: "file",
          stored: false,
        }),
      ).toBe(true);

      expect(store.findFileByCid("bafkreistored")?.id).toBe(storedId);
      expect(store.findFileByCid("bafkreipending")).toBeUndefined();
      expect(store.fileObjects()).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
