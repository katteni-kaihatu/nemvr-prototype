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
import {
  isFileCategory,
  isFiniteNumber,
  isValidBoxSize,
  isValidCid,
  isValidColor,
  isValidFileSize,
  isValidHttpUrl,
  isValidObjectId,
  isValidObjectName,
  isValidObjectScale,
  isValidOwner,
  isValidPosition,
  isValidTransform,
  isValidWorldObjectRecord,
} from "./validate.js";

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

function projectObject(
  id: string,
  value: unknown,
  transforms?: Y.Map<WorldTransform>,
): WorldObject | undefined {
  if (!isValidObjectId(id) || !(value instanceof Y.Map)) return undefined;
  const kind = value.get("kind");
  const shared = transforms?.get(id);
  const transform = isValidTransform(shared) ? shared : value.get("transform");
  if (!isValidTransform(transform)) return undefined;

  const position = clonePosition(transform.position);
  const base = {
    id,
    position,
    yaw: transform.yaw,
    ...(isFiniteNumber(transform.pitch) ? { pitch: transform.pitch } : {}),
    ...(isFiniteNumber(transform.scale) ? { scale: transform.scale } : {}),
  };

  switch (kind) {
    case "image": {
      const cid = value.get("cid");
      const width = value.get("width");
      const height = value.get("height");
      const name = value.get("name");
      if (!isValidCid(cid)) return undefined;
      if (!isFiniteNumber(width) || width <= 0) return undefined;
      if (!isFiniteNumber(height) || height <= 0) return undefined;
      if (name !== undefined && !isValidObjectName(name)) return undefined;
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
      if (!isValidCid(cid)) return undefined;
      if (!isValidObjectName(name)) return undefined;
      if (!isValidFileSize(size)) return undefined;
      if (stored !== undefined && typeof stored !== "boolean") return undefined;
      if (!isFileCategory(category)) return undefined;
      if (owner !== undefined && !isValidOwner(owner)) return undefined;
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
      if (!isValidBoxSize(size)) return undefined;
      if (!isValidColor(color)) return undefined;
      const box: BoxObject = { ...base, kind: "box", size, color };
      return box;
    }
    case "link": {
      const url = value.get("url");
      if (!isValidHttpUrl(url)) return undefined;
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

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

const FILE_METADATA_KEYS: ReadonlySet<string> = new Set([
  "stored",
  "size",
  "category",
  "owner",
  "offline",
  "name",
]);

export class WorldDoc {
  readonly doc: Y.Doc;
  readonly actorId: string;

  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly transforms: Y.Map<WorldTransform>;
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
    this.transforms = this.doc.getMap<WorldTransform>("transforms");
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
      if (this.deleted.has(id)) continue;
      const object = projectObject(id, value, this.transforms);
      if (object !== undefined) objects.push(object);
    }
    objects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return objects;
  }

  getObject(id: string): WorldObject | undefined {
    if (this.deleted.has(id)) return undefined;
    return projectObject(id, this.objects.get(id), this.transforms);
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  count(): number {
    return this.getObjects().length;
  }

  createObject(object: WorldObject, origin?: unknown): boolean {
    if (!isValidWorldObjectRecord(object)) return false;
    const id = object.id;
    if (this.deleted.has(id) || this.objects.has(id)) return false;
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
    extra?: { updateId?: string; scale?: number },
  ): boolean {
    if (!isValidObjectId(id)) return false;
    if (!isValidPosition(position) || !isFiniteNumber(yaw)) return false;
    if (pitch !== undefined && !isFiniteNumber(pitch)) return false;
    if (extra?.scale !== undefined && !isValidObjectScale(extra.scale)) return false;
    if (this.deleted.has(id)) return false;
    const record = this.objects.get(id);
    if (!(record instanceof Y.Map)) return false;
    const shared = this.transforms.get(id);
    const current = isValidTransform(shared) ? shared : record.get("transform");
    if (!isValidTransform(current)) return false;

    const effectivePitch = pitch !== undefined ? pitch : current.pitch;
    const effectiveScale = extra?.scale !== undefined ? extra.scale : current.scale;
    const updateId =
      extra !== undefined && typeof extra.updateId === "string" && extra.updateId.length > 0
        ? extra.updateId
        : this.idFactory();
    const next = this.makeTransform(position, yaw, effectivePitch, effectiveScale, updateId);
    this.doc.transact(() => {
      this.transforms.set(id, next);
      record.set("transform", next);
    });
    return true;
  }

  setMetadata(id: string, patch: ObjectMetadataPatch, _extra?: { updateId?: string }): boolean {
    if (!isValidObjectId(id) || !isRecord(patch)) return false;
    if (this.deleted.has(id)) return false;
    const record = this.objects.get(id);
    if (!(record instanceof Y.Map)) return false;

    const kind = record.get("kind");
    const fields = patch as Record<string, unknown>;
    if (kind === "image") {
      for (const key of Object.keys(fields)) {
        if (key !== "name") return false;
      }
      if (has(fields, "name") && fields["name"] !== undefined && typeof fields["name"] !== "string") {
        return false;
      }
    } else if (kind === "file") {
      const allowed = FILE_METADATA_KEYS;
      for (const key of Object.keys(fields)) {
        if (!allowed.has(key)) return false;
      }
      if (has(fields, "stored") && fields["stored"] !== undefined && typeof fields["stored"] !== "boolean") {
        return false;
      }
      if (has(fields, "size") && fields["size"] !== undefined && !isValidFileSize(fields["size"])) return false;
      if (has(fields, "category") && fields["category"] !== undefined && !isFileCategory(fields["category"])) {
        return false;
      }
      if (has(fields, "owner") && fields["owner"] !== undefined && !isValidOwner(fields["owner"])) return false;
      if (has(fields, "offline") && fields["offline"] !== undefined && typeof fields["offline"] !== "boolean") {
        return false;
      }
      if (has(fields, "name") && fields["name"] !== undefined && !isValidObjectName(fields["name"])) return false;
    } else {
      return false;
    }

    this.doc.transact(() => {
      if (kind === "image") {
        if (isValidObjectName(fields["name"])) record.set("name", fields["name"]);
        return;
      }
      if (fields["stored"] !== undefined) record.set("stored", fields["stored"]);
      if (fields["size"] !== undefined) record.set("size", fields["size"]);
      if (fields["category"] !== undefined) record.set("category", fields["category"]);
      if (isValidObjectName(fields["name"])) record.set("name", fields["name"]);

      if (has(fields, "owner")) {
        if (isValidOwner(fields["owner"]) && fields["owner"].length > 0) record.set("owner", fields["owner"]);
        else record.delete("owner");
      }
      if (has(fields, "offline")) {
        if (fields["offline"] === true) record.set("offline", true);
        else record.delete("offline");
      }
    });
    return true;
  }

  deleteObject(id: string, origin?: unknown): boolean {
    if (!isValidObjectId(id)) return false;
    if (this.deleted.has(id)) return true;
    this.doc.transact(() => {
      this.deleted.set(id, true);
    }, origin);
    return true;
  }

  duplicateObject(sourceId: string, newObject: WorldObject): boolean {
    if (!isValidWorldObjectRecord(newObject)) return false;
    if (!isValidObjectId(sourceId) || newObject.id === sourceId) return false;
    if (this.deleted.has(sourceId)) return false;
    if (this.getObject(sourceId) === undefined) return false;
    return this.createObject(newObject);
  }

  replaceFromSnapshot(objects: WorldObject[], origin?: unknown): void {
    this.doc.transact(() => {
      const snapshotIds = new Set<string>();
      for (const object of objects) {
        if (!isValidWorldObjectRecord(object)) continue;
        if (this.deleted.has(object.id)) continue;
        snapshotIds.add(object.id);
        this.upsertObject(object);
      }
      for (const id of [...this.objects.keys()]) {
        if (!snapshotIds.has(id) && !this.deleted.has(id)) {
          this.deleted.set(id, true);
        }
      }
    }, origin);
  }

  mergeFromSnapshot(objects: WorldObject[], origin?: unknown): void {
    this.doc.transact(() => {
      for (const object of objects) {
        if (!isValidWorldObjectRecord(object)) continue;
        if (this.deleted.has(object.id)) continue;
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
    scale: number | undefined,
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
    if (scale !== undefined) transform.scale = scale;
    return transform;
  }

  private writeObject(object: WorldObject): void {
    const record = new Y.Map<unknown>();
    record.set("kind", object.kind);
    const transform = this.makeTransform(object.position, object.yaw, object.pitch, object.scale);
    record.set("transform", transform);
    this.transforms.set(object.id, transform);

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

    if (existing.get("kind") !== object.kind) return;

    const transform = this.makeTransform(object.position, object.yaw, object.pitch, object.scale);
    existing.set("transform", transform);
    this.transforms.set(object.id, transform);

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

/**
 * デモボックスは、オフラインだった複数のレプリカが後から同期しても
 * 同じ id で衝突するよう、固定の UUID を使う。
 */
const DEMO_BOX_IDS: ReadonlyArray<string> = [
  "5eed0000-0000-4000-8000-000000000001",
  "5eed0000-0000-4000-8000-000000000002",
  "5eed0000-0000-4000-8000-000000000003",
  "5eed0000-0000-4000-8000-000000000004",
  "5eed0000-0000-4000-8000-000000000005",
];

export function seedDemoBoxes(world: WorldDoc): void {
  const meta = world.doc.getMap<unknown>("meta");
  const objects = world.doc.getMap<Y.Map<unknown>>("objects");
  if (meta.get("seeded") === "v1" || objects.size > 0) return;

  world.doc.transact(() => {
    meta.set("seeded", "v1");
    for (let index = 0; index < DEMO_BOXES.length; index++) {
      const box = DEMO_BOXES[index]!;
      world.createObject({
        id: DEMO_BOX_IDS[index]!,
        kind: "box",
        position: clonePosition(box.position),
        yaw: box.yaw,
        size: box.size,
        color: box.color,
      });
    }
  }, "seed");
}
