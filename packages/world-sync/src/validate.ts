import {
  MAX_ABS_POSITION,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LENGTH,
  MAX_OBJECT_SIZE,
  MAX_URL_LENGTH,
  MIN_OBJECT_SIZE,
} from "@proto/protocol";
import type { FileCategory, Vec3, WorldObject } from "@proto/protocol";
import type { WorldTransform } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_CATEGORIES: ReadonlySet<string> = new Set<FileCategory>(["audio", "video", "file"]);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
export const MAX_CID_LENGTH = 256;
export const MAX_OWNER_LENGTH = 256;

export function isValidObjectId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

/** 位置の各成分がプロトコルの範囲内か。 */
export function isValidPosition(value: unknown): value is Vec3 {
  return isValidVec3(value) && value.every((component) => Math.abs(component) <= MAX_ABS_POSITION);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function codePointLength(value: string): number {
  return [...value].length;
}

export function isValidCid(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= MAX_CID_LENGTH;
}

/** オブジェクトの表示名。ファイル名は sanitizeFileName の上限に合わせる。 */
export function isValidObjectName(value: unknown): value is string {
  return typeof value === "string" && codePointLength(value) <= MAX_FILE_NAME_LENGTH;
}

export function isValidOwner(value: unknown): value is string {
  return typeof value === "string" && codePointLength(value) <= MAX_OWNER_LENGTH;
}

export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_RE.test(value);
}

export function isValidBoxSize(value: unknown): value is number {
  return isFiniteNumber(value) && value >= MIN_OBJECT_SIZE && value <= MAX_OBJECT_SIZE;
}

export function isValidFileSize(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_FILE_BYTES;
}

export function isValidTransform(value: unknown): value is WorldTransform {
  if (!isPlainObject(value)) return false;
  return (
    isValidPosition(value["position"]) &&
    isFiniteNumber(value["yaw"]) &&
    (value["pitch"] === undefined || isFiniteNumber(value["pitch"])) &&
    isNonEmptyString(value["updateId"]) &&
    isNonEmptyString(value["actorId"]) &&
    isFiniteNumber(value["at"])
  );
}

export function isFileCategory(value: unknown): value is FileCategory {
  return typeof value === "string" && FILE_CATEGORIES.has(value);
}

export function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 文書に書く前・projection に出す前に、信頼できない WorldObject 風の値を検証する。
 * 未知の追加フィールドは無視する。
 */
export function isValidWorldObjectRecord(value: unknown): value is WorldObject {
  if (!isPlainObject(value)) return false;
  if (!isValidObjectId(value["id"])) return false;
  if (!isValidPosition(value["position"])) return false;
  if (!isFiniteNumber(value["yaw"])) return false;
  if (value["pitch"] !== undefined && !isFiniteNumber(value["pitch"])) return false;

  switch (value["kind"]) {
    case "image": {
      return (
        isValidCid(value["cid"]) &&
        isFiniteNumber(value["width"]) &&
        value["width"] > 0 &&
        isFiniteNumber(value["height"]) &&
        value["height"] > 0 &&
        (value["name"] === undefined || isValidObjectName(value["name"]))
      );
    }
    case "file": {
      return (
        isValidCid(value["cid"]) &&
        isValidObjectName(value["name"]) &&
        isValidFileSize(value["size"]) &&
        (value["stored"] === undefined || typeof value["stored"] === "boolean") &&
        isFileCategory(value["category"]) &&
        (value["owner"] === undefined || isValidOwner(value["owner"])) &&
        (value["offline"] === undefined || typeof value["offline"] === "boolean")
      );
    }
    case "box": {
      return isValidBoxSize(value["size"]) && isValidColor(value["color"]);
    }
    case "link": {
      return isValidHttpUrl(value["url"]);
    }
    default:
      return false;
  }
}
