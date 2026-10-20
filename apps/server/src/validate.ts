import { CID } from "multiformats/cid";
import {
  MAX_ABS_POSITION,
  MAX_NAME_LENGTH,
  MAX_URL_LENGTH,
  MAX_OBJECT_SIZE,
  MIN_OBJECT_SIZE,
  sanitizeFileName,
  type ClientMessage,
  type PlaceBox,
  type PlaceFile,
  type PlaceImage,
  type PlaceUrl,
  type Pose,
  type Quat,
  type SyncPart,
  type Vec3,
} from "@proto/protocol";

function isFiniteArray(v: unknown, length: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === length &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function normalizeQuat(q: number[]): Quat | null {
  const [x = 0, y = 0, z = 0, w = 0] = q;
  const len = Math.hypot(x, y, z, w);
  if (len < 1e-6) return null;
  return [x / len, y / len, z / len, w / len];
}

export function parsePose(v: unknown): Pose | null {
  if (typeof v !== "object" || v === null) return null;
  const { position, head, crouch, lean } = v as Record<string, unknown>;
  if (!isFiniteArray(position, 3) || !isFiniteArray(head, 4)) return null;
  if (position.some((n) => Math.abs(n) > MAX_ABS_POSITION)) return null;
  const q = normalizeQuat(head);
  if (!q) return null;
  // しゃがみは任意。あれば有限の数に限り、0〜1 に丸める
  if (crouch !== undefined && (typeof crouch !== "number" || !Number.isFinite(crouch))) return null;
  // リーンも任意。あれば有限の数に限り、-1〜1 に丸める
  if (lean !== undefined && (typeof lean !== "number" || !Number.isFinite(lean))) return null;
  return {
    position: position as Vec3,
    head: q,
    ...(crouch === undefined ? {} : { crouch: Math.max(0, Math.min(1, crouch)) }),
    ...(lean === undefined ? {} : { lean: Math.max(-1, Math.min(1, lean)) }),
  };
}

const MAX_CID_LENGTH = 128;
const CODEC_DAG_PB = 0x70;
const CODEC_RAW = 0x55;
const HASH_SHA2_256 = 0x12;

/**
 * UnixFS ファイルの CID (dag-pb または raw, sha2-256) だけを受け付け、正規化した文字列を返す。
 * 解釈できなければ null。
 */
export function normalizeCid(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_CID_LENGTH) return null;
  try {
    const cid = CID.parse(v);
    if (cid.code !== CODEC_DAG_PB && cid.code !== CODEC_RAW) return null;
    if (cid.multihash.code !== HASH_SHA2_256) return null;
    return cid.toString();
  } catch {
    return null;
  }
}

function isSize(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_OBJECT_SIZE && v <= MAX_OBJECT_SIZE;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** オブジェクト ID (サーバーが randomUUID で採番したもの)。 */
function parseObjectId(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

const WORLD_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CLAIM_SESSION_RE = /^[A-Za-z0-9:_-]{8,128}$/;
/** 同期の state vector / update の base64 文字列の上限 (再構成後の上限 16 MiB に対応)。 */
const MAX_SYNC_FIELD_LENGTH = 16 * 1024 * 1024;
/** sync_part の 1 片の base64 文字列の上限。 */
const MAX_SYNC_PART_LENGTH = 1024 * 1024;

/**
 * base64 かどうかを、文字ごとに調べる。
 * 巨大な文字列に正規表現をかけるとスタックを消費する環境があるため、正規表現は使わない。
 */
function isBase64String(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.length > 0 && value.charCodeAt(value.length - 1) === 61 /* = */) {
    padding = value.charCodeAt(value.length - 2) === 61 ? 2 : 1;
  }
  const paddingStart = value.length - padding;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code === 43 || // +
      code === 47 // /
    ) {
      continue;
    }
    if (code === 61 && i >= paddingStart) continue; // =
    return false;
  }
  return true;
}

/** 明らかに base64 でない文字列を、デコードする前に早めに弾く。 */
function parseBase64String(v: unknown, maxLength: number): string | null {
  return typeof v === "string" && v.length <= maxLength && isBase64String(v) ? v : null;
}

/** objectId (クライアント生成 UUID) は任意。ある場合だけ検証して返す。 */
function parseOptionalObjectId(v: unknown): { objectId?: string } | null {
  if (v === undefined) return {};
  const id = parseObjectId(v);
  return id ? { objectId: id } : null;
}

/** 位置 (有限・範囲内) と向き (有限) を検証する。置く・動かすメッセージで共通。 */
function parsePlacement(v: Record<string, unknown>): { position: Vec3; yaw: number; pitch?: number } | null {
  const { position, yaw, pitch } = v;
  if (!isFiniteArray(position, 3)) return null;
  if (position.some((n) => Math.abs(n) > MAX_ABS_POSITION)) return null;
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return null;
  if (pitch !== undefined && (typeof pitch !== "number" || !Number.isFinite(pitch))) return null;
  return pitch === undefined ? { position: position as Vec3, yaw } : { position: position as Vec3, yaw, pitch };
}

/** 向き (yaw・pitch) の検証。 */
function parseAngles(v: Record<string, unknown>): { yaw: number; pitch?: number } | null {
  const { yaw, pitch } = v;
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return null;
  if (pitch !== undefined && (typeof pitch !== "number" || !Number.isFinite(pitch))) return null;
  return pitch === undefined ? { yaw } : { yaw, pitch };
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** place_url の検証。URL の到達性・公開性は、取得するときに別途確かめる。 */
export function parsePlaceUrl(v: Record<string, unknown>): PlaceUrl | null {
  const placement = parsePlacement(v);
  if (!placement) return null;
  const { url } = v;
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  const objectId = parseOptionalObjectId(v.objectId);
  return objectId ? { url, ...placement, ...objectId } : null;
}

/** place_box の検証。デモ用のボックス配置・テスト用。 */
export function parsePlaceBox(v: Record<string, unknown>): PlaceBox | null {
  const placement = parsePlacement(v);
  if (!placement) return null;
  const { size, color } = v;
  if (typeof size !== "number" || !Number.isFinite(size) || size < MIN_OBJECT_SIZE || size > MAX_OBJECT_SIZE) return null;
  if (typeof color !== "string" || !COLOR_RE.test(color)) return null;
  const objectId = parseOptionalObjectId(v.objectId);
  return objectId ? { ...placement, size, color, ...objectId } : null;
}

export function parsePlaceImage(v: Record<string, unknown>): PlaceImage | null {
  const cid = normalizeCid(v.cid);
  const placement = parsePlacement(v);
  if (!cid || !placement) return null;
  const { width, height } = v;
  if (!isSize(width) || !isSize(height)) return null;
  const objectId = parseOptionalObjectId(v.objectId);
  if (!objectId) return null;
  // ファイル名は任意 (ダウンロード時の名前)。あれば整える
  const name = typeof v.name === "string" ? sanitizeFileName(v.name, "") : "";
  return { cid, ...placement, width, height, ...(name ? { name } : {}), ...objectId };
}

/** size と category はサーバーが中身から決めるので、受け取らない。 */
export function parsePlaceFile(v: Record<string, unknown>): PlaceFile | null {
  const cid = normalizeCid(v.cid);
  const placement = parsePlacement(v);
  if (!cid || !placement) return null;
  const objectId = parseOptionalObjectId(v.objectId);
  return objectId ? { cid, name: sanitizeFileName(v.name), ...placement, ...objectId } : null;
}

export function sanitizeName(raw: unknown, fallbackSuffix: string): string {
  const name = typeof raw === "string" ? raw.trim().slice(0, MAX_NAME_LENGTH) : "";
  return name.length > 0 ? name : `Guest-${fallbackSuffix}`;
}

/** 受信テキストを ClientMessage に変換する。不正なら null。 */
export function parseClientMessage(text: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  switch (msg.type) {
    case "join":
      // name の検証は sanitizeName に任せる
      return { type: "join", name: typeof msg.name === "string" ? msg.name : "" };
    case "pose": {
      const pose = parsePose(msg.pose);
      return pose ? { type: "pose", pose } : null;
    }
    case "grab_object":
    case "release_object":
    case "delete_object":
    case "duplicate_object":
    case "request_file": {
      const id = parseObjectId(msg.id);
      return id ? { type: msg.type, id } : null;
    }
    case "video_control": {
      const id = parseObjectId(msg.id);
      const { playing, time } = msg;
      if (!id || typeof playing !== "boolean") return null;
      if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 24 * 60 * 60) return null;
      return { type: "video_control", id, playing, time };
    }
    case "move_object": {
      const id = parseObjectId(msg.id);
      const { position } = msg;
      const angles = parseAngles(msg);
      if (!id || !isFiniteArray(position, 3) || position.some((n) => Math.abs(n) > MAX_ABS_POSITION) || !angles) return null;
      return { type: "move_object", id, position: position as Vec3, ...angles };
    }
    case "place_url": {
      const place = parsePlaceUrl(msg);
      return place ? { type: "place_url", ...place } : null;
    }
    case "place_box": {
      const place = parsePlaceBox(msg);
      return place ? { type: "place_box", ...place } : null;
    }
    case "ipfs_peer": {
      // libp2p のピア ID (base58 / base32 の英数字)
      const id = msg.peerId;
      return typeof id === "string" && /^[A-Za-z0-9]{10,128}$/.test(id)
        ? { type: "ipfs_peer", peerId: id }
        : null;
    }
    case "set_avatar": {
      // null は簡易アバターに戻す。文字列なら、置くファイルと同じ CID の形だけを受け付ける
      if (msg.cid === null) return { type: "set_avatar", cid: null };
      const cid = normalizeCid(msg.cid);
      return cid ? { type: "set_avatar", cid } : null;
    }
    case "place_file": {
      const place = parsePlaceFile(msg);
      return place ? { type: "place_file", ...place } : null;
    }
    case "place_image": {
      const place = parsePlaceImage(msg);
      return place ? { type: "place_image", ...place } : null;
    }
    case "sync_hello": {
      const { worldId, schemaVersion, stateVector } = msg;
      if (typeof worldId !== "string" || !WORLD_ID_RE.test(worldId)) return null;
      if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion <= 0) return null;
      const vector = parseBase64String(stateVector, MAX_SYNC_FIELD_LENGTH);
      return vector === null ? null : { type: "sync_hello", worldId, schemaVersion, stateVector: vector };
    }
    case "sync_update": {
      const update = parseBase64String(msg.update, MAX_SYNC_FIELD_LENGTH);
      return update === null ? null : { type: "sync_update", update };
    }
    case "sync_part": {
      const { transferId, index, count, data } = msg;
      if (typeof transferId !== "string" || transferId.length === 0 || transferId.length > 256) return null;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 4096) return null;
      if (index >= count) return null;
      const partData = parseBase64String(data, MAX_SYNC_PART_LENGTH);
      if (partData === null) return null;
      const part: SyncPart = { transferId, index, count, data: partData };
      return { type: "sync_part", ...part };
    }
    case "claim": {
      const id = parseObjectId(msg.id);
      const { sessionId, seq, until } = msg;
      if (!id || typeof sessionId !== "string" || !CLAIM_SESSION_RE.test(sessionId)) return null;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
      if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) return null;
      return { type: "claim", id, sessionId, seq, until };
    }
    case "claim_release": {
      const id = parseObjectId(msg.id);
      const { sessionId } = msg;
      if (!id || typeof sessionId !== "string" || !CLAIM_SESSION_RE.test(sessionId)) return null;
      return { type: "claim_release", id, sessionId };
    }
    default:
      return null;
  }
}
