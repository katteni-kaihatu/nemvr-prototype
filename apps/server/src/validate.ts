import {
  MAX_ABS_POSITION,
  MAX_NAME_LENGTH,
  type ClientMessage,
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
    default:
      return null;
  }
}
