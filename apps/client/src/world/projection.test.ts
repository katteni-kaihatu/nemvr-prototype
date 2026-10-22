import { describe, expect, it } from "vitest";
import type { SpaceEntity } from "@proto/protocol";
import { poseFromEntity, projectEntities } from "./projection";

const entity = (id: string, dimensions: Record<string, unknown>): SpaceEntity => ({
  id,
  version: 1,
  dimensions: dimensions as SpaceEntity["dimensions"],
});

describe("projectEntities", () => {
  it("projects boxes, images, files, links and peers", () => {
    const world = projectEntities([
      entity("box", {
        "entity.kind": "box",
        "space.position": [1, 0, 2],
        "space.yaw": 0.5,
        "box.size": 2,
        "box.color": "#aabbcc",
      }),
      entity("image", {
        "entity.kind": "image",
        "space.position": [3, 0, 4],
        "space.yaw": 0,
        "content.cid": "bafy-image",
        "content.width": 2,
        "content.height": 1,
      }),
      entity("file", {
        "entity.kind": "file",
        "space.position": [0, 0, 0],
        "space.yaw": 0,
        "content.cid": "bafy-file",
        "content.name": "clip.mp4",
        "content.size": 42,
        "content.stored": true,
        "content.category": "video",
        "time.playback": { playing: true, time: 3, at: 1000 },
      }),
      entity("link", {
        "entity.kind": "link",
        "space.position": [0, 0, 0],
        "space.yaw": 0,
        "content.url": "https://example.com/",
      }),
      entity("peer", {
        "entity.kind": "peer",
        "space.position": [5, 0, 6],
        "space.head": [0, 0, 0, 1],
        "space.crouch": 0.25,
        "space.lean": -0.5,
        "peer.name": "alice",
        "peer.color": "#123456",
        "peer.avatarCid": "bafy-avatar",
      }),
    ]);

    expect(world.objects.box).toMatchObject({ kind: "box", size: 2, color: "#aabbcc", yaw: 0.5 });
    expect(world.objects.image).toMatchObject({ kind: "image", width: 2, height: 1, cid: "bafy-image" });
    expect(world.objects.file).toMatchObject({
      kind: "file",
      name: "clip.mp4",
      size: 42,
      stored: true,
      category: "video",
    });
    expect(world.objects.link).toMatchObject({ kind: "link", url: "https://example.com/" });
    expect(world.peers.peer).toMatchObject({
      name: "alice",
      color: "#123456",
      avatarCid: "bafy-avatar",
    });
    expect(world.videoStates.file).toEqual({ playing: true, time: 3, at: 1000 });
  });

  it("fills defaults for missing dimensions", () => {
    const world = projectEntities([
      entity("box", { "entity.kind": "box", "space.position": [1, 2, 3] }),
    ]);

    expect(world.objects.box).toMatchObject({
      kind: "box",
      position: [1, 2, 3],
      yaw: 0,
      pitch: 0,
      scale: 1,
      size: 1,
    });
  });

  it("extracts a peer pose", () => {
    const peer = entity("peer", {
      "entity.kind": "peer",
      "space.position": [1, 0, 2],
      "space.head": [0, 0, 0, 1],
      "space.crouch": 1,
      "space.lean": -1,
    });

    expect(poseFromEntity(peer)).toEqual({
      position: [1, 0, 2],
      head: [0, 0, 0, 1],
      crouch: 1,
      lean: -1,
    });
  });
});
