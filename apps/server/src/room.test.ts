import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { FILE_ICON_WIDTH, type ServerMessage, type WorldObject } from "@proto/protocol";
import { Room } from "./room.js";

/** Room が使う最小限の WebSocket。送られたメッセージを溜める。 */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  clear(): void {
    this.sent = [];
  }
}

const CID = "bafkreigrdheq5ptzw7vvhpb7oo7dxenzlcz4eggaew7novpz6fppsvdnuy";

function setup() {
  const room = new Room({ peerId: "p", wsPort: 1 });
  const a = new FakeSocket();
  const b = new FakeSocket();
  const aId = room.join(a as unknown as WebSocket, "alice").id;
  const bId = room.join(b as unknown as WebSocket, "bob").id;
  room.addImage({ cid: CID, position: [1, 0, 2], yaw: 0, width: 2, height: 1 });
  const objectId = a.of("object_added")[0]!.object.id;
  a.clear();
  b.clear();
  return { room, a, b, aId, bId, objectId };
}

describe("grab / move / release", () => {
  it("lets one peer grab, and tells everyone", () => {
    const { room, a, b, aId, objectId } = setup();
    room.grabObject(aId, objectId);
    for (const s of [a, b]) {
      expect(s.of("object_updated")[0]!.object.heldBy).toBe(aId);
    }
  });

  it("rejects a second grab and tells only the requester (with the current state)", () => {
    const { room, a, b, aId, bId, objectId } = setup();
    room.grabObject(aId, objectId);
    a.clear();
    b.clear();

    room.grabObject(bId, objectId);
    expect(b.of("error")[0]!.message).toMatch(/つかんでいます/);
    expect(b.of("object_updated")[0]!.object.heldBy).toBe(aId);
    expect(a.sent).toEqual([]); // 持っている本人には何も飛ばない
  });

  it("only accepts moves from the holder, and does not echo to the sender", () => {
    const { room, a, b, aId, bId, objectId } = setup();
    room.grabObject(aId, objectId);
    a.clear();
    b.clear();

    room.moveObject(aId, objectId, [5, 0, 6], 1.5);
    expect(a.sent).toEqual([]);
    const moved = b.of("object_updated")[0]!.object;
    expect(moved.position).toEqual([5, 0, 6]);
    expect(moved.yaw).toBe(1.5);

    b.clear();
    room.moveObject(bId, objectId, [9, 0, 9], 0); // つかんでいない人の移動は無視
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
  });

  it("ignores moves for objects nobody holds", () => {
    const { room, b, bId, objectId } = setup();
    room.moveObject(bId, objectId, [9, 0, 9], 0);
    expect(b.sent).toEqual([]);
  });

  it("releases only for the holder", () => {
    const { room, a, b, aId, bId, objectId } = setup();
    room.grabObject(aId, objectId);
    a.clear();
    b.clear();

    room.releaseObject(bId, objectId); // 他人は離せない
    expect(a.sent).toEqual([]);

    room.releaseObject(aId, objectId);
    expect(b.of("object_updated")[0]!.object.heldBy).toBeUndefined();
  });

  it("holds one object at a time (grabbing another releases the first)", () => {
    const { room, a, aId, objectId } = setup();
    room.addImage({ cid: CID, position: [3, 0, 3], yaw: 0, width: 2, height: 1 });
    const secondId = a.of("object_added")[0]!.object.id;
    room.grabObject(aId, objectId);
    a.clear();

    room.grabObject(aId, secondId);
    const updates = a.of("object_updated").map((m) => [m.object.id, m.object.heldBy]);
    expect(updates).toContainEqual([objectId, undefined]);
    expect(updates).toContainEqual([secondId, aId]);
  });

  it("releases held objects when the holder disconnects", () => {
    const { room, b, aId, objectId } = setup();
    room.grabObject(aId, objectId);
    b.clear();

    room.leave(aId);
    const updated = b.of("object_updated")[0]!.object;
    expect(updated.id).toBe(objectId);
    expect(updated.heldBy).toBeUndefined();
  });
});

describe("delete", () => {
  it("removes the object for everyone", () => {
    const { room, a, b, aId, objectId } = setup();
    room.deleteObject(aId, objectId);
    expect(a.of("object_removed")[0]!.id).toBe(objectId);
    expect(b.of("object_removed")[0]!.id).toBe(objectId);
    expect(room.isFull).toBe(false);
  });

  it("refuses to delete an object someone else holds", () => {
    const { room, a, b, aId, bId, objectId } = setup();
    room.grabObject(aId, objectId);
    a.clear();
    b.clear();

    room.deleteObject(bId, objectId);
    expect(b.of("error")[0]!.message).toMatch(/つかんでいます/);
    expect(b.of("object_removed")).toEqual([]);

    // 持っている本人は削除できる
    room.deleteObject(aId, objectId);
    expect(b.of("object_removed")[0]!.id).toBe(objectId);
  });

  it("ignores unknown ids", () => {
    const { room, a, aId } = setup();
    room.deleteObject(aId, "00000000-0000-4000-8000-000000000000");
    expect(a.sent).toEqual([]);
  });

  it("a deleted object is not sent to later joiners", () => {
    const { room, aId, objectId } = setup();
    room.deleteObject(aId, objectId);
    const c = new FakeSocket();
    room.join(c as unknown as WebSocket, "carol");
    const welcome = c.of("welcome")[0]!;
    expect(welcome.objects).toEqual([]);
  });
});

describe("duplicate", () => {
  it("adds a copy next to the original with a new id", () => {
    const { room, a, b, aId, objectId } = setup();
    room.duplicateObject(aId, objectId);
    for (const s of [a, b]) {
      const copy = s.of("object_added")[0]!.object;
      expect(copy.id).not.toBe(objectId);
      expect(copy.cid).toBe(CID);
      expect(copy).toMatchObject({ kind: "image", width: 2, height: 1 });
      expect(copy.yaw).toBe(0);
      // yaw 0: 右 (+X) に 0.6、法線 (+Z) に 0.05
      expect(copy.position[0]).toBeCloseTo(1.6);
      expect(copy.position[1]).toBe(0);
      expect(copy.position[2]).toBeCloseTo(2.05);
    }
  });

  it("offsets along the rotated right vector", () => {
    const { room, a, aId } = setup();
    room.addImage({ cid: CID, position: [0, 0, 0], yaw: Math.PI / 2, width: 2, height: 1 });
    const id = a.of("object_added").at(-1)!.object.id;
    a.clear();
    room.duplicateObject(aId, id);
    const copy = a.of("object_added")[0]!.object;
    // yaw 90°: 右は -Z 方向、法線は +X 方向
    expect(copy.position[0]).toBeCloseTo(0.05);
    expect(copy.position[2]).toBeCloseTo(-0.6);
  });

  it("does not copy the held state, and keeps the original held", () => {
    const { room, a, b, aId, bId, objectId } = setup();
    room.grabObject(aId, objectId);
    b.clear();
    room.duplicateObject(bId, objectId);
    expect(b.of("object_added")[0]!.object.heldBy).toBeUndefined();
    // 元のオブジェクトは持たれたまま
    const welcome = (() => {
      const c = new FakeSocket();
      room.join(c as unknown as WebSocket, "carol");
      return c.of("welcome")[0]!.objects as WorldObject[];
    })();
    expect(welcome.find((o) => o.id === objectId)!.heldBy).toBe(aId);
  });

  it("refuses when the world is full", () => {
    const { room, a, aId, objectId } = setup();
    for (let i = 0; room.isFull === false; i++) {
      room.addImage({ cid: CID, position: [0, 0, 0], yaw: 0, width: 1, height: 1 });
    }
    a.clear();
    room.duplicateObject(aId, objectId);
    expect(a.of("error")[0]!.message).toMatch(/これ以上/);
    expect(a.of("object_added")).toEqual([]);
  });
});

describe("files", () => {
  const file = { cid: CID, name: "report.pdf", position: [1, 0.4, 2] as [number, number, number], yaw: 0, size: 1234, category: "file" as const, stored: true };

  it("adds a file object and broadcasts it (size and category as decided by the server)", () => {
    const { room, a, b } = setup();
    expect(room.addFile(file)).toBe(true);
    for (const s of [a, b]) {
      const o = s.of("object_added")[0]!.object;
      expect(o).toMatchObject({ kind: "file", cid: CID, name: "report.pdf", size: 1234, category: "file" });
      expect(o.id).toBeTruthy();
    }
  });

  it("includes files in welcome for later joiners, alongside images", () => {
    const { room } = setup();
    room.addFile(file);
    const c = new FakeSocket();
    room.join(c as unknown as WebSocket, "carol");
    const kinds = c.of("welcome")[0]!.objects.map((o) => o.kind).sort();
    expect(kinds).toEqual(["file", "image"]);
  });

  it("refuses to add a file when the world is full", () => {
    const { room } = setup();
    while (!room.isFull) room.addFile(file);
    expect(room.addFile(file)).toBe(false);
  });

  it("returns the removed object on delete (so the server can release its content)", () => {
    const { room, aId } = setup();
    room.addFile(file);
    const added = (room as unknown as { objects: Map<string, WorldObject> }).objects;
    const fileObject = [...added.values()].find((o) => o.kind === "file")!;
    expect(room.deleteObject(aId, fileObject.id)?.cid).toBe(CID);
    expect(room.deleteObject(aId, fileObject.id)).toBeNull(); // 2 回目は存在しない
  });

  it("returns null when deleting something another peer holds", () => {
    const { room, b, aId, bId, objectId } = setup();
    room.grabObject(aId, objectId);
    b.clear();
    expect(room.deleteObject(bId, objectId)).toBeNull();
    expect(b.of("error")[0]!.message).toMatch(/つかんでいます/);
  });

  it("duplicates a file next to the original with no overlap, keeping name / size / category", () => {
    const { room, a, aId } = setup();
    room.addFile({ ...file, position: [0, 0.4, 0] });
    const id = a.of("object_added").at(-1)!.object.id;
    a.clear();

    const copy = room.duplicateObject(aId, id)!;
    expect(copy).toMatchObject({ kind: "file", name: "report.pdf", size: 1234, category: "file", cid: CID });
    expect(copy.id).not.toBe(id);
    // アイコンの幅より離れて置く (重ならない)
    expect(copy.position[0]).toBeGreaterThanOrEqual(FILE_ICON_WIDTH);
    expect(copy.position[1]).toBe(0.4);
    expect(a.of("object_added")[0]!.object.id).toBe(copy.id);
  });

  it("returns the copy from duplicateObject, and null when nothing was copied", () => {
    const { room, aId, objectId } = setup();
    expect(room.duplicateObject(aId, objectId)?.cid).toBe(CID);
    expect(room.duplicateObject(aId, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("lazy files (not transferred until downloaded)", () => {
  const FILE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const lazy = (owner: string, over: Partial<{ cid: string; name: string }> = {}) => ({
    cid: over.cid ?? FILE_CID,
    name: over.name ?? "big.bin",
    position: [0, 0.6, 0] as [number, number, number],
    yaw: 0,
    size: 1_500_000_000,
    category: "file" as const,
    stored: false,
    owner,
  });
  const files = (s: FakeSocket) => s.sent.filter((m) => m.type === "object_added").map((m) => (m as { object: WorldObject }).object);

  it("adds an unstored file that records who is serving it", () => {
    const { room, a, b, aId } = setup();
    expect(room.addFile(lazy(aId))).toBe(true);
    for (const s of [a, b]) {
      expect(files(s).at(-1)).toMatchObject({ kind: "file", stored: false, owner: aId, size: 1_500_000_000 });
    }
  });

  it("markStored turns every unstored file with that CID into a stored one, with the measured size", () => {
    const { room, a, b, aId } = setup();
    room.addFile(lazy(aId));
    const first = files(a).at(-1)!;
    const copy = room.duplicateObject(aId, first.id)!; // 複製も、同じ中身を指す (保持していない)
    room.addFile(lazy(aId, { cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", name: "other.bin" }));
    a.clear();
    b.clear();

    const updated = room.markStored(FILE_CID, 1_400_000_000);
    expect(updated.map((o) => o.id).sort()).toEqual([first.id, copy.id].sort());
    for (const s of [a, b]) {
      const sent = s.of("object_updated").map((m) => m.object);
      expect(sent).toHaveLength(2); // 別の CID のものには触れない
      for (const o of sent) {
        expect(o).toMatchObject({ kind: "file", stored: true, size: 1_400_000_000 });
        expect(o).not.toHaveProperty("owner");
        expect(o).not.toHaveProperty("offline");
      }
    }
    expect(room.markStored(FILE_CID, 1)).toEqual([]); // 保持済みのものは、もう更新しない
  });

  it("marks unstored files offline when their owner leaves (stored files and other owners are unaffected)", () => {
    const { room, a, b, aId, bId } = setup();
    room.addFile(lazy(aId));
    room.addFile({ ...lazy(bId, { cid: "bafybeif3ycql2wqz2txluxtfvb7ppui3r7aqzddjnayai6qgxv72vmklyy", name: "bobs.bin" }) });
    room.addFile({ ...lazy(aId), cid: "bafkreiepuym22t7h35oztjjcleody23xnogolspik46jayzu7k3cblk32i", name: "stored.bin", stored: true, owner: undefined });
    b.clear();

    room.leave(aId);
    const offline = b.of("object_updated").map((m) => m.object);
    expect(offline).toHaveLength(1); // alice が配っていた、保持していない 1 つだけ
    expect(offline[0]).toMatchObject({ name: "big.bin", offline: true, stored: false });
    void a;
  });

  it("clears the offline mark when the content is later stored", () => {
    const { room, b, aId } = setup();
    room.addFile(lazy(aId));
    room.leave(aId);
    b.clear();
    const [updated] = room.markStored(FILE_CID, 1);
    expect(updated).not.toHaveProperty("offline");
  });

  it("a copy of an unstored file is unstored too, and is served by the same owner", () => {
    const { room, a, aId } = setup();
    room.addFile(lazy(aId));
    const original = files(a).at(-1)!;
    const copy = room.duplicateObject(aId, original.id)!;
    expect(copy).toMatchObject({ kind: "file", stored: false, owner: aId, cid: FILE_CID });
  });

  it("getObject returns the object, or undefined", () => {
    const { room, aId, objectId } = setup();
    expect(room.getObject(objectId)?.id).toBe(objectId);
    expect(room.getObject("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    void aId;
  });

  it("sends prepare progress / failure only to the requester", () => {
    const { room, a, b, aId } = setup();
    a.clear();
    b.clear();
    room.sendPrepareProgress(aId, FILE_CID, 100, 1000);
    room.sendPrepareProgress(aId, FILE_CID, 0, undefined, true);
    room.sendPrepareFailed(aId, FILE_CID, "no");
    expect(a.of("prepare_progress")).toEqual([
      { type: "prepare_progress", cid: FILE_CID, loaded: 100, total: 1000 },
      { type: "prepare_progress", cid: FILE_CID, loaded: 0, queued: true },
    ]);
    expect(a.of("prepare_failed")[0]).toMatchObject({ cid: FILE_CID, message: "no" });
    expect(b.sent).toEqual([]);
  });
});
