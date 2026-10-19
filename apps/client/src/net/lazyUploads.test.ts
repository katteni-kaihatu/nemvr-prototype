import { describe, expect, it } from "vitest";
import type { FileObject, ImageObject, WorldObject } from "@proto/protocol";
import { needsLocalFile } from "./lazyUploads";

const file = (id: string, over: Partial<FileObject> = {}): FileObject => ({
  id,
  kind: "file",
  cid: "cid-a",
  name: "big.bin",
  size: 1_000_000_000,
  category: "file",
  position: [0, 0, 0],
  yaw: 0,
  stored: false,
  owner: "me",
  ...over,
});
const world = (...objects: WorldObject[]) => Object.fromEntries(objects.map((o) => [o.id, o]));

describe("needsLocalFile", () => {
  it("is true while a file I placed has not been stored by the server yet", () => {
    expect(needsLocalFile(world(file("1")), "cid-a", "me")).toBe(true);
  });

  it("is false once the server has stored it", () => {
    expect(needsLocalFile(world(file("1", { stored: true, owner: undefined })), "cid-a", "me")).toBe(false);
  });

  it("is false once every such object has been deleted", () => {
    expect(needsLocalFile({}, "cid-a", "me")).toBe(false);
  });

  it("stays true while at least one of several objects with the same content is still unstored (e.g. a copy)", () => {
    const objects = world(file("1", { stored: true, owner: undefined }), file("2"));
    expect(needsLocalFile(objects, "cid-a", "me")).toBe(true);
  });

  it("ignores files that someone else is serving, other contents, and images", () => {
    const image: ImageObject = { id: "i", kind: "image", cid: "cid-a", position: [0, 0, 0], yaw: 0, width: 1, height: 1 };
    const objects = world(file("1", { owner: "someone-else" }), file("2", { cid: "cid-b" }), image);
    expect(needsLocalFile(objects, "cid-a", "me")).toBe(false);
  });

  it("keeps serving a stored video that I placed, while the tab is open (for browser-to-browser P2P)", () => {
    const video = file("1", { category: "video", name: "clip.webm", stored: true, owner: undefined });
    expect(needsLocalFile(world(video), "cid-a", "me", true)).toBe(true);
    // 配っていなければ (他の人が置いた映像なら)、配る必要はない
    expect(needsLocalFile(world(video), "cid-a", "me", false)).toBe(false);
    // 映像以外は、保持されたら配るのをやめる
    const bin = file("2", { stored: true, owner: undefined });
    expect(needsLocalFile(world(bin), "cid-a", "me", true)).toBe(false);
    // すべて削除されたら、配るのをやめる
    expect(needsLocalFile({}, "cid-a", "me", true)).toBe(false);
  });

  it("is false when I am not known yet", () => {
    expect(needsLocalFile(world(file("1")), "cid-a", undefined)).toBe(false);
  });
});
