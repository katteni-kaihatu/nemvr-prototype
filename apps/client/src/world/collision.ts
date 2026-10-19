/**
 * オブジェクトのコライダーと、キャラクターとの当たり判定。描画や入力から切り離した、純粋な計算 (three.js を使わない)。
 *
 * - オブジェクトは、回転 (水平 yaw・垂直 pitch。three.js の回転順序 YXZ と同じ) した直方体として扱う。
 *   箱は立方体、画像・ファイルは薄い板 (板の厚み PLATE_THICKNESS)。位置は底面 (板は下辺) の中央。
 * - キャラクターは、縦に 3 つ並べた球 (足・胴・頭) で扱う。球と直方体の判定は、直方体の座標系に直すだけで済むので、
 *   傾いた箱の上でも、壁・天井・床として、同じ計算で扱える。
 * - 押し出しは、いちばん深く食い込んでいるものから順に行う。
 */
import { FILE_ICON_HEIGHT, FILE_ICON_WIDTH, type Vec3, type WorldObject } from "@proto/protocol";

/** 画像・ファイルの板の厚み (m)。薄いが、歩く速さでは、すり抜けない厚さ。 */
export const PLATE_THICKNESS = 0.06;
/** キャラクターの球の半径 (m)。 */
export const PLAYER_RADIUS = 0.3;
/** 目の高さより上に、頭の球の上端がある高さ (m)。 */
export const HEAD_MARGIN = 0.2;
/** 接触とみなす距離 (m)。この距離以内なら、押し出さなくても「触れている」(立っている) と扱う。 */
export const CONTACT_SKIN = 0.01;
/** 足元の面が、この向き (法線の Y) より上を向いていれば、立てる地面とみなす (約 60 度まで)。 */
export const GROUND_NORMAL_Y = 0.5;
const MAX_ITERATIONS = 8;

export interface Collider {
  /** 位置 (ワールド座標)。底面 (板は下辺) の中央。 */
  position: Vec3;
  yaw: number;
  pitch: number;
  /** 直方体の中心 (オブジェクトのローカル座標) と、各軸の半分の大きさ */
  center: Vec3;
  half: Vec3;
}

/**
 * オブジェクトのコライダー。誰かがつかんでいるものは、手元で動かしているので、当たり判定を外す (null)。
 * 持っている人が、持っているものに押し返されないように、また、他の人の手の中のものに引っかからないようにするため。
 */
export function colliderFor(object: WorldObject): Collider | null {
  if (object.heldBy) return null;
  const base = { position: object.position, yaw: object.yaw, pitch: object.pitch ?? 0 };
  switch (object.kind) {
    case "box": {
      const h = object.size / 2;
      return { ...base, center: [0, h, 0], half: [h, h, h] };
    }
    case "image":
      return { ...base, center: [0, object.height / 2, 0], half: [object.width / 2, object.height / 2, PLATE_THICKNESS / 2] };
    case "file":
      return { ...base, center: [0, FILE_ICON_HEIGHT / 2, 0], half: [FILE_ICON_WIDTH / 2, FILE_ICON_HEIGHT / 2, PLATE_THICKNESS / 2] };
  }
}

/** 回転行列 R = Ry(yaw) * Rx(pitch) (three.js の YXZ、z = 0)。行ごとに返す。 */
function rotation(yaw: number, pitch: number): [Vec3, Vec3, Vec3] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const cb = Math.cos(pitch);
  const sb = Math.sin(pitch);
  return [
    [c, s * sb, s * cb],
    [0, cb, -sb],
    [-s, c * sb, c * cb],
  ];
}

export interface Contact {
  /** 球を押し出す向きと量 (ワールド座標)。触れているだけ (押し出し不要) なら 0。 */
  push: Vec3;
  /** 押し出す向き (ワールド座標、単位ベクトル)。足元の面が上を向いているかの判定に使う。 */
  normal: Vec3;
  /** 食い込んでいる深さ (m)。負なら、CONTACT_SKIN 以内で触れているだけ。 */
  depth: number;
}

/** 球 (中心 c、半径 r) と、コライダーの接触。触れていなければ null。 */
export function sphereVsCollider(c: Vec3, r: number, col: Collider): Contact | null {
  const R = rotation(col.yaw, col.pitch);
  // 球の中心を、直方体の座標系 (中心が原点) に直す: local = R^T (c - position) - center
  const d: Vec3 = [c[0] - col.position[0], c[1] - col.position[1], c[2] - col.position[2]];
  const local: Vec3 = [
    R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2] - col.center[0],
    R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2] - col.center[1],
    R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2] - col.center[2],
  ];
  // 直方体の上で、球の中心にいちばん近い点
  const closest: Vec3 = [
    Math.max(-col.half[0], Math.min(col.half[0], local[0])),
    Math.max(-col.half[1], Math.min(col.half[1], local[1])),
    Math.max(-col.half[2], Math.min(col.half[2], local[2])),
  ];
  const diff: Vec3 = [local[0] - closest[0], local[1] - closest[1], local[2] - closest[2]];
  const dist = Math.hypot(diff[0], diff[1], diff[2]);

  let normalLocal: Vec3;
  let depth: number;
  if (dist > 1e-9) {
    if (dist >= r + CONTACT_SKIN) return null;
    normalLocal = [diff[0] / dist, diff[1] / dist, diff[2] / dist];
    depth = r - dist;
  } else {
    // 中心が直方体の中にある: 食い込みがいちばん浅い軸の向きへ、外に出す
    let axis = 0;
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const pen = col.half[i]! - Math.abs(local[i]!);
      if (pen < best) {
        best = pen;
        axis = i;
      }
    }
    normalLocal = [0, 0, 0];
    normalLocal[axis] = local[axis]! >= 0 ? 1 : -1;
    depth = best + r;
  }
  // 向きを、ワールド座標へ: normal = R * normalLocal
  const normal: Vec3 = [
    R[0][0] * normalLocal[0] + R[0][1] * normalLocal[1] + R[0][2] * normalLocal[2],
    R[1][0] * normalLocal[0] + R[1][1] * normalLocal[1] + R[1][2] * normalLocal[2],
    R[2][0] * normalLocal[0] + R[2][1] * normalLocal[1] + R[2][2] * normalLocal[2],
  ];
  const amount = Math.max(0, depth);
  return { push: [normal[0] * amount, normal[1] * amount, normal[2] * amount], normal, depth };
}

/** キャラクターの高さ (足元から頭の上端まで)。しゃがむと低くなる。 */
export const bodyHeightFor = (eyeHeight: number): number => eyeHeight + HEAD_MARGIN;

/** キャラクターの 3 つの球の中心 (足・胴・頭)。pos は足元。 */
export function bodySpheres(pos: Vec3, height: number): Vec3[] {
  const feet = PLAYER_RADIUS;
  const head = Math.max(feet, height - PLAYER_RADIUS);
  return [
    [pos[0], pos[1] + feet, pos[2]],
    [pos[0], pos[1] + (feet + head) / 2, pos[2]],
    [pos[0], pos[1] + head, pos[2]],
  ];
}

export interface Resolved {
  /** 押し出したあとの足元の位置 */
  position: Vec3;
  /** 上を向いた面 (床・箱の上) に触れていて、立っている */
  grounded: boolean;
  /** 下を向いた面 (天井・箱の裏) に頭が当たっている */
  hitCeiling: boolean;
  /** 横向きの面 (壁) に当たっている */
  hitWall: boolean;
}

/**
 * キャラクターをコライダーから押し出す。いちばん深く食い込んでいる接触から順に、位置を直していく。
 * 立てる (grounded) か、天井 (hitCeiling)・壁 (hitWall) に当たっているかも返す。
 */
export function resolvePlayer(position: Vec3, height: number, colliders: readonly Collider[]): Resolved {
  const pos: Vec3 = [...position];
  let grounded = false;
  let hitCeiling = false;
  let hitWall = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let worst: Contact | null = null;
    for (const sphere of bodySpheres(pos, height)) {
      for (const col of colliders) {
        const contact = sphereVsCollider(sphere, PLAYER_RADIUS, col);
        if (contact && (!worst || contact.depth > worst.depth)) worst = contact;
      }
    }
    if (!worst) break;
    if (worst.depth > 0) {
      pos[0] += worst.push[0];
      pos[1] += worst.push[1];
      pos[2] += worst.push[2];
    }
    if (worst.normal[1] > GROUND_NORMAL_Y) grounded = true;
    else if (worst.normal[1] < -GROUND_NORMAL_Y) hitCeiling = true;
    else hitWall = true;
    if (worst.depth <= 0) break; // 触れているだけ。これ以上、直すものはない
  }

  // 触れているだけの接触 (立っているか) は、最後の位置でもう一度確かめる (押し出した直後は、深い方しか見ていないため)
  if (!grounded) {
    for (const sphere of bodySpheres(pos, height)) {
      for (const col of colliders) {
        const contact = sphereVsCollider(sphere, PLAYER_RADIUS, col);
        if (contact && contact.normal[1] > GROUND_NORMAL_Y) grounded = true;
      }
    }
  }
  return { position: pos, grounded, hitCeiling, hitWall };
}

/** その位置・高さで、キャラクターがコライダーに食い込むか (立ち上がれるかの確認に使う)。 */
export function overlapsAny(position: Vec3, height: number, colliders: readonly Collider[]): boolean {
  for (const sphere of bodySpheres(position, height)) {
    for (const col of colliders) {
      const contact = sphereVsCollider(sphere, PLAYER_RADIUS, col);
      if (contact && contact.depth > 0) return true;
    }
  }
  return false;
}
