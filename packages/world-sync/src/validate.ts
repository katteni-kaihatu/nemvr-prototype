import type { FileCategory, Vec3, WorldObject } from "@proto/protocol";
import type { WorldTransform } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_CATEGORIES: ReadonlySet<string> = new Set<FileCategory>(["audio", "video", "file"]);
const MAX_URL_LENGTH = 2048;

export function isValidObjectId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isValidTransform(value: unknown): value is WorldTransform {
  if (!isPlainObject(value)) return false;
  return (
    isValidVec3(value["position"]) &&
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

function isHttpUrl(value: string): boolean {
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
  if (!isValidVec3(value["position"])) return false;
  if (!isFiniteNumber(value["yaw"])) return false;
  if (value["pitch"] !== undefined && !isFiniteNumber(value["pitch"])) return false;

  switch (value["kind"]) {
    case "image": {
      return (
        isNonEmptyString(value["cid"]) &&
        isFiniteNumber(value["width"]) &&
        value["width"] > 0 &&
        isFiniteNumber(value["height"]) &&
        value["height"] > 0 &&
        (value["name"] === undefined || typeof value["name"] === "string")
      );
    }
    case "file": {
      return (
        isNonEmptyString(value["cid"]) &&
        typeof value["name"] === "string" &&
        isFiniteNumber(value["size"]) &&
        value["size"] >= 0 &&
        (value["stored"] === undefined || typeof value["stored"] === "boolean") &&
        isFileCategory(value["category"]) &&
        (value["owner"] === undefined || typeof value["owner"] === "string") &&
        (value["offline"] === undefined || typeof value["offline"] === "boolean")
      );
    }
    case "box": {
      return (
        isFiniteNumber(value["size"]) &&
        value["size"] > 0 &&
        typeof value["color"] === "string" &&
        /^#[0-9a-f]{6}$/i.test(value["color"])
      );
    }
    case "link": {
      return typeof value["url"] === "string" && isHttpUrl(value["url"]);
    }
    default:
      return false;
  }
}
