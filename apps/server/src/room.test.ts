import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ServerMessage, WorldObject } from "@proto/protocol";
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
      expect(copy.width).toBe(2);
      expect(copy.height).toBe(1);
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
