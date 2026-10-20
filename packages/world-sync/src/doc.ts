import * as Y from "yjs";
import type {
  BoxObject,
  FileObject,
  ImageObject,
  LinkObject,
  Vec3,
  WorldObject,
} from "@proto/protocol";
import type { ObjectMetadataPatch, WorldDocOptions, WorldTransform } from "./types.js";
import { isFileCategory, isFiniteNumber, isValidObjectId, isValidTransform, isValidVec3, isValidWorldObjectRecord } from "./validate.js";

function fallbackId(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultIdFactory(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return fallbackId();
}

function clonePosition(position: Vec3): Vec3 {
  return [position[0], position[1], position[2]];
}

function projectObject(id: string, value: unknown): WorldObject | undefined {
  if (!isValidObjectId(id) || !(value instanceof Y.Map)) return undefined;
  const kind = value.get("kind");
  const transform = value.get("transform");
  if (!isValidTransform(transform)) return undefined;

  const position = clonePosition(transform.position);
  const base = {
    id,
    position,
    yaw: transform.yaw,
    ...(isFiniteNumber(transform.pitch) ? { pitch: transform.pitch } : {}),
  };

  switch (kind) {
    case "image": {
      const cid = value.get("cid");
      const width = value.get("width");
      const height = value.get("height");
      const name = value.get("name");
      if (typeof cid !== "string" || cid.length === 0) return undefined;
      if (!isFiniteNumber(width) || width <= 0) return undefined;
      if (!isFiniteNumber(height) || height <= 0) return undefined;
      if (name !== undefined && typeof name !== "string") return undefined;
      const image: ImageObject = {
        ...base,
        kind: "image",
        cid,
        width,
        height,
        ...(typeof name === "string" ? { name } : {}),
      };
      return image;
    }
    case "file": {
      const cid = value.get("cid");
      const name = value.get("name");
      const size = value.get("size");
      const stored = value.get("stored");
      const category = value.get("category");
      const owner = value.get("owner");
      const offline = value.get("offline");
      if (typeof cid !== "string" || cid.length === 0) return undefined;
      if (typeof name !== "string") return undefined;
      if (!isFiniteNumber(size) || size < 0) return undefined;
      if (stored !== undefined && typeof stored !== "boolean") return undefined;
      if (!isFileCategory(category)) return undefined;
      if (owner !== undefined && typeof owner !== "string") return undefined;
      if (offline !== undefined && typeof offline !== "boolean") return undefined;
      const file: FileObject = {
        ...base,
        kind: "file",
        cid,
        name,
        size,
        stored: stored === true,
        category,
        ...(typeof owner === "string" && owner.length > 0 ? { owner } : {}),
        ...(offline === true ? { offline: true } : {}),
      };
      return file;
    }
    case "box": {
      const size = value.get("size");
      const color = value.get("color");
      if (!isFiniteNumber(size) || size <= 0) return undefined;
      if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
      const box: BoxObject = { ...base, kind: "box", size, color };
      return box;
    }
    case "link": {
      const url = value.get("url");
      if (typeof url !== "string") return undefined;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      } catch {
        return undefined;
      }
      const link: LinkObject = { ...base, kind: "link", url };
      return link;
    }
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class WorldDoc {
  readonly doc: Y.Doc;
  readonly actorId: string;

  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly deleted: Y.Map<boolean>;
  private readonly meta: Y.Map<unknown>;

  constructor(options: WorldDocOptions, existingDoc?: Y.Doc) {
    if (!options || typeof options.actorId !== "string" || options.actorId.length === 0) {
      throw new TypeError("WorldDoc requires a non-empty actorId");
    }
    this.doc = existingDoc ?? options.doc ?? new Y.Doc();
    this.actorId = options.actorId;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.objects = this.doc.getMap<Y.Map<unknown>>("objects");
    this.deleted = this.doc.getMap<boolean>("deleted");
    this.meta = this.doc.getMap<unknown>("meta");
  }

  static fromUpdate(update: Uint8Array, options: WorldDocOptions): WorldDoc {
    const world = new WorldDoc(options);
    world.applyUpdate(update);
    return world;
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  encodeUpdate(stateVector?: Uint8Array): Uint8Array {
    return stateVector === undefined
      ? Y.encodeStateAsUpdate(this.doc)
      : Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  applyUpdate(update: Uint8Array, origin?: unknown): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  onUpdate(cb: (update: Uint8Array, origin: unknown) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown): void => {
      cb(update, origin);
    };
    this.doc.on("update", handler);
    return () => {
      this.doc.off("update", handler);
    };
  }

  getObjects(): WorldObject[] {
    const objects: WorldObject[] = [];
    for (const [id, value] of this.objects) {
      if (this.deleted.get(id) === true) continue;
      const object = projectObject(id, value);
      if (object !== undefined) objects.push(object);
    }
    objects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return objects;
  }

  getObject(id: string): WorldObject | undefined {
    if (this.deleted.get(id) === true) return undefined;
    return projectObject(id, this.objects.get(id));
  }

  isDeleted(id: string): boolean {
    return this.deleted.get(id) === true;
  }

  count(): number {
    return this.getObjects().length;
  }

  createObject(object: WorldObject, origin?: unknown): boolean {
    if (!isValidWorldObjectRecord(object)) return false;
    const id = object.id;
    if (this.deleted.get(id) === true || this.objects.has(id)) return false;
    this.doc.transact(() => {
      this.writeObject(object);
    }, origin);
    return true;
  }

  moveObject(
    id: string,
    position: Vec3,
    yaw: number,
    pitch?: number,
    extra?: { updateId?: string },
  ): boolean {
    if (!isValidObjectId(id)) return false;
    if (!isValidVec3(position) || !isFiniteNumber(yaw)) return false;
    if (pitch !== undefined && !isFiniteNumber(pitch)) return false;
    if (this.deleted.get(id) === true) return false;
    const record = this.objects.get(id);
    if (!(record instanceof Y.Map)) return false;
    const current = record.get("transform");
    if (!isValidTransform(current)) return false;

    const effectivePitch = pitch !== undefined ? pitch : current.pitch;
    const updateId =
      extra !== undefined && typeof extra.updateId === "string" && extra.updateId.length > 0
        ? extra.updateId
        : this.idFactory();
    this.doc.transact(() => {
      record.set("transform", this.makeTransform(position, yaw, effectivePitch, updateId));
    });
    return true;
  }

  setMetadata(id: string, patch: ObjectMetadataPatch, _extra?: { updateId?: string }): boolean {
    if (!isValidObjectId(id) || !isRecord(patch)) return false;
    if (this.deleted.get(id) === true) return false;
    const record = this.objects.get(id);
    if (!(record instanceof Y.Map)) return false;

    const has = (key: string): boolean => Object.hasOwn(patch, key);
    if (has("stored") && patch.stored !== undefined && typeof patch.stored !== "boolean") return false;
    if (has("size") && patch.size !== undefined && (!isFiniteNumber(patch.size) || patch.size < 0)) return false;
    if (has("category") && patch.category !== undefined && !isFileCategory(patch.category)) return false;
    if (has("owner") && patch.owner !== undefined && typeof patch.owner !== "string") return false;
    if (has("offline") && patch.offline !== undefined && typeof patch.offline !== "boolean") return false;
    if (has("name") && patch.name !== undefined && typeof patch.name !== "string") return false;

    this.doc.transact(() => {
      if (patch.stored !== undefined) record.set("stored", patch.stored);
      if (patch.size !== undefined) record.set("size", patch.size);
      if (patch.category !== undefined) record.set("category", patch.category);
      if (patch.name !== undefined) record.set("name", patch.name);

      if (has("owner")) {
        if (typeof patch.owner === "string" && patch.owner.length > 0) record.set("owner", patch.owner);
        else record.delete("owner");
      }
      if (has("offline")) {
        if (patch.offline === true) record.set("offline", true);
        else record.delete("offline");
      }
    });
    return true;
  }

  deleteObject(id: string, origin?: unknown): boolean {
    if (!isValidObjectId(id)) return false;
    if (this.deleted.get(id) === true) return true;
    this.doc.transact(() => {
      this.deleted.set(id, true);
    }, origin);
    return true;
  }

  duplicateObject(sourceId: string, newObject: WorldObject): boolean {
    if (!isValidWorldObjectRecord(newObject)) return false;
    if (!isValidObjectId(sourceId) || newObject.id === sourceId) return false;
    if (this.deleted.get(sourceId) === true) return false;
    if (this.getObject(sourceId) === undefined) return false;
    return this.createObject(newObject);
  }

  replaceFromSnapshot(objects: WorldObject[], origin?: unknown): void {
    this.doc.transact(() => {
      const snapshotIds = new Set<string>();
      for (const object of objects) {
        if (!isValidWorldObjectRecord(object)) continue;
        if (this.deleted.get(object.id) === true) continue;
        snapshotIds.add(object.id);
        this.upsertObject(object);
      }
      for (const id of [...this.objects.keys()]) {
        if (!snapshotIds.has(id) && this.deleted.get(id) !== true) {
          this.deleted.set(id, true);
        }
      }
    }, origin);
  }

  mergeFromSnapshot(objects: WorldObject[], origin?: unknown): void {
    this.doc.transact(() => {
      for (const object of objects) {
        if (!isValidWorldObjectRecord(object)) continue;
        if (this.deleted.get(object.id) === true) continue;
        this.upsertObject(object);
      }
    }, origin);
  }

  destroy(): void {
    this.doc.destroy();
  }

  private makeTransform(
    position: Vec3,
    yaw: number,
    pitch: number | undefined,
    updateId?: string,
  ): WorldTransform {
    const transform: WorldTransform = {
      position: clonePosition(position),
      yaw,
      updateId: updateId ?? this.idFactory(),
      actorId: this.actorId,
      at: this.now(),
    };
    if (pitch !== undefined) transform.pitch = pitch;
    return transform;
  }

  private writeObject(object: WorldObject): void {
    const record = new Y.Map<unknown>();
    record.set("kind", object.kind);
    record.set(
      "transform",
      this.makeTransform(object.position, object.yaw, object.pitch),
    );

    switch (object.kind) {
      case "image":
        record.set("cid", object.cid);
        record.set("width", object.width);
        record.set("height", object.height);
        if (object.name !== undefined) record.set("name", object.name);
        break;
      case "file":
        record.set("cid", object.cid);
        record.set("name", object.name);
        record.set("size", object.size);
        record.set("stored", object.stored === true);
        record.set("category", object.category);
        if (object.owner !== undefined && object.owner.length > 0) record.set("owner", object.owner);
        if (object.offline === true) record.set("offline", true);
        break;
      case "box":
        record.set("size", object.size);
        record.set("color", object.color);
        break;
      case "link":
        record.set("url", object.url);
        break;
    }

    const extra = object as unknown as Record<string, unknown>;
    if (isFiniteNumber(extra["createdAt"])) record.set("createdAt", extra["createdAt"]);
    if (typeof extra["createdBy"] === "string" && extra["createdBy"].length > 0) {
      record.set("createdBy", extra["createdBy"]);
    }

    this.objects.set(object.id, record);
  }

  private upsertObject(object: WorldObject): void {
    const existing = this.objects.get(object.id);
    if (!(existing instanceof Y.Map)) {
      this.writeObject(object);
      return;
    }

    existing.set("transform", this.makeTransform(object.position, object.yaw, object.pitch));
    if (existing.get("kind") !== object.kind) return;

    if (object.kind === "file") {
      existing.set("name", object.name);
      existing.set("size", object.size);
      existing.set("stored", object.stored === true);
      existing.set("category", object.category);
      if (object.owner !== undefined && object.owner.length > 0) existing.set("owner", object.owner);
      else existing.delete("owner");
      if (object.offline === true) existing.set("offline", true);
      else existing.delete("offline");
    } else if (object.kind === "image" && object.name !== undefined) {
      existing.set("name", object.name);
    }
  }
}

export const DEMO_BOXES: ReadonlyArray<{
  position: Vec3;
  yaw: number;
  size: number;
  color: string;
}> = [
  { position: [0, 0, 0], yaw: 0, size: 1, color: "#d9534f" },
  { position: [6, 0, -4], yaw: 0, size: 2, color: "#5bc0de" },
  { position: [-7, 0, -6], yaw: 0, size: 1.5, color: "#5cb85c" },
  { position: [10, 0, 8], yaw: 0, size: 1, color: "#f0ad4e" },
  { position: [-10, 0, 7], yaw: 0, size: 3, color: "#9b59b6" },
];

export function seedDemoBoxes(world: WorldDoc): void {
  const meta = world.doc.getMap<unknown>("meta");
  const objects = world.doc.getMap<Y.Map<unknown>>("objects");
  if (meta.get("seeded") === "v1" || objects.size > 0) return;

  world.doc.transact(() => {
    meta.set("seeded", "v1");
    for (const box of DEMO_BOXES) {
      world.createObject({
        id: defaultIdFactory(),
        kind: "box",
        position: clonePosition(box.position),
        yaw: box.yaw,
        size: box.size,
        color: box.color,
      });
    }
  }, "seed");
}
