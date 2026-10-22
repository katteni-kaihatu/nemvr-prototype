import type {
  FileCategory,
  PeerInfo,
  Pose,
  Quat,
  SpaceEntity,
  Vec3,
  VideoPlaybackState,
  WorldObject,
} from "@proto/protocol";

export interface ProjectedWorld {
  objects: Record<string, WorldObject>;
  peers: Record<string, PeerInfo>;
  videoStates: Record<string, VideoPlaybackState>;
}

type Dims = Record<string, unknown>;

const isRecord = (value: unknown): value is Dims =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asVec3 = (value: unknown, fallback: Vec3): Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number")
    ? [value[0] as number, value[1] as number, value[2] as number]
    : fallback;

const asQuat = (value: unknown): Quat =>
  Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number")
    ? [value[0] as number, value[1] as number, value[2] as number, value[3] as number]
    : [0, 0, 0, 1];

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const dimsOf = (entity: SpaceEntity): Dims => entity.dimensions as Dims;

export function poseFromEntity(entity: SpaceEntity): Pose {
  const dims = dimsOf(entity);
  return {
    position: asVec3(dims["space.position"], [0, 0, 0]),
    head: asQuat(dims["space.head"]),
    crouch: asNumber(dims["space.crouch"], 0),
    lean: asNumber(dims["space.lean"], 0),
  };
}

export function projectEntity(entity: SpaceEntity): WorldObject | null {
  const dims = dimsOf(entity);
  const kind = dims["entity.kind"];
  if (typeof kind !== "string" || kind === "peer") return null;

  const base = {
    id: entity.id,
    position: asVec3(dims["space.position"], [0, 0, 0]),
    yaw: asNumber(dims["space.yaw"], 0),
    pitch: asNumber(dims["space.pitch"], 0),
    scale: asNumber(dims["space.scale"], 1),
    heldBy: typeof dims["interaction.heldBy"] === "string" ? (dims["interaction.heldBy"] as string) : undefined,
  };

  switch (kind) {
    case "image":
      return {
        ...base,
        kind: "image",
        cid: asString(dims["content.cid"]),
        width: asNumber(dims["content.width"], 1),
        height: asNumber(dims["content.height"], 1),
        name: asString(dims["content.name"]) || undefined,
      };
    case "file":
      return {
        ...base,
        kind: "file",
        cid: asString(dims["content.cid"]),
        name: asString(dims["content.name"], "file"),
        size: asNumber(dims["content.size"], 0),
        stored: asBoolean(dims["content.stored"]),
        owner: asString(dims["content.owner"]) || undefined,
        offline: asBoolean(dims["content.offline"]) || undefined,
        category: (asString(dims["content.category"], "file") as FileCategory),
      };
    case "box":
      return {
        ...base,
        kind: "box",
        size: asNumber(dims["box.size"], 1),
        color: asString(dims["box.color"], "#888888"),
      };
    case "link":
      return {
        ...base,
        kind: "link",
        url: asString(dims["content.url"]),
      };
    default:
      return null;
  }
}

export function projectPeer(entity: SpaceEntity): PeerInfo {
  const dims = dimsOf(entity);
  return {
    id: entity.id,
    name: asString(dims["peer.name"], "Guest"),
    color: asString(dims["peer.color"], "#888888"),
    avatarCid: asString(dims["peer.avatarCid"]) || undefined,
  };
}

export function projectEntities(entities: Iterable<SpaceEntity>): ProjectedWorld {
  const objects: Record<string, WorldObject> = {};
  const peers: Record<string, PeerInfo> = {};
  const videoStates: Record<string, VideoPlaybackState> = {};

  for (const entity of entities) {
    const dims = dimsOf(entity);
    const kind = dims["entity.kind"];

    if (kind === "peer") {
      peers[entity.id] = projectPeer(entity);
    } else {
      const object = projectEntity(entity);
      if (object) objects[object.id] = object;
    }

    const playback = dims["time.playback"];
    if (isRecord(playback)) {
      videoStates[entity.id] = {
        playing: asBoolean(playback["playing"]),
        time: asNumber(playback["time"], 0),
        at: asNumber(playback["at"], 0),
      };
    }
  }

  return { objects, peers, videoStates };
}
