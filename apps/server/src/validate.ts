import { CID } from "multiformats/cid";
import {
  MAX_ABS_POSITION,
  MAX_NAME_LENGTH,
  MAX_OBJECT_SIZE,
  MIN_OBJECT_SIZE,
  type ClientMessage,
  type PlaceImage,
  type Pose,
  type Quat,
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
  const { position, head } = v as Record<string, unknown>;
  if (!isFiniteArray(position, 3) || !isFiniteArray(head, 4)) return null;
  if (position.some((n) => Math.abs(n) > MAX_ABS_POSITION)) return null;
  const q = normalizeQuat(head);
  if (!q) return null;
  return { position: position as Vec3, head: q };
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

export function parsePlaceImage(v: Record<string, unknown>): PlaceImage | null {
  const { position, yaw, width, height } = v;
  const cid = normalizeCid(v.cid);
  if (!cid) return null;
  if (!isFiniteArray(position, 3)) return null;
  if (position.some((n) => Math.abs(n) > MAX_ABS_POSITION)) return null;
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return null;
  if (!isSize(width) || !isSize(height)) return null;
  return { cid, position: position as Vec3, yaw, width, height };
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
    case "ipfs_peer": {
      // libp2p のピア ID (base58 / base32 の英数字)
      const id = msg.peerId;
      return typeof id === "string" && /^[A-Za-z0-9]{10,128}$/.test(id)
        ? { type: "ipfs_peer", peerId: id }
        : null;
    }
    case "place_image": {
      const place = parsePlaceImage(msg);
      return place ? { type: "place_image", ...place } : null;
    }
    default:
      return null;
  }
}
