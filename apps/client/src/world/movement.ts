/**
 * 縦方向の動き (ジャンプ・しゃがみ) の計算。描画や入力から切り離して、単体でテストできるようにしている。
 * 地面は y = 0 (ワールドは平らで、物にはぶつからない)。
 */

/** 立っているときの目の高さ (m)。 */
export const EYE_HEIGHT = 1.6;
/** しゃがみきったときの目の高さ (m)。 */
export const CROUCH_EYE_HEIGHT = 0.9;
/** しゃがんでいるときの、歩く速さの倍率 (しゃがみきったとき)。 */
export const CROUCH_SPEED_FACTOR = 0.5;
/** 重力加速度 (m/s^2)。現実より強めにして、ジャンプを軽快にする。 */
export const GRAVITY = 20;
/** ジャンプの初速 (m/s)。頂点の高さは v^2 / (2g) = 0.9m、滞空は約 0.6 秒。 */
export const JUMP_SPEED = 6;
/** しゃがみの深さが目標に近づく速さ (大きいほど速い)。 */
const CROUCH_RATE = 14;
/** しゃがんでいる (この深さ以上) 間は、ジャンプできない。 */
const JUMP_BLOCKED_CROUCH = 0.5;

export interface Vertical {
  /** 足元の高さ (m)。地面にいれば 0。 */
  y: number;
  /** 上向きの速さ (m/s) */
  vy: number;
  /** しゃがみの深さ。0 = 立っている、1 = しゃがみきっている。 */
  crouch: number;
}

export interface VerticalInput {
  jump: boolean;
  crouch: boolean;
}

export const initialVertical = (): Vertical => ({ y: 0, vy: 0, crouch: 0 });

/** 地面に立っているか (ジャンプを始められるか)。 */
export const isGrounded = (v: Vertical): boolean => v.y <= 0 && v.vy <= 0;

/** しゃがみの深さから、目の高さを求める (足元から)。 */
export function eyeHeightFor(crouch: number): number {
  const c = Math.max(0, Math.min(1, crouch));
  return EYE_HEIGHT + (CROUCH_EYE_HEIGHT - EYE_HEIGHT) * c;
}

/** しゃがみの深さから、歩く速さの倍率を求める。 */
export function speedFactorFor(crouch: number): number {
  const c = Math.max(0, Math.min(1, crouch));
  return 1 - (1 - CROUCH_SPEED_FACTOR) * c;
}

/** dt 秒ぶん進める。入力は、押されているか。ジャンプは、地面に立っていて、しゃがんでいないときだけ始まる。 */
export function stepVertical(v: Vertical, input: VerticalInput, dt: number): Vertical {
  // しゃがみは、目標の深さへ滑らかに近づく (空中でもしゃがめる)
  const target = input.crouch ? 1 : 0;
  const crouch = v.crouch + (target - v.crouch) * (1 - Math.exp(-CROUCH_RATE * dt));

  let vy = v.vy;
  if (input.jump && isGrounded(v) && v.crouch < JUMP_BLOCKED_CROUCH) vy = JUMP_SPEED;

  vy -= GRAVITY * dt;
  let y = v.y + vy * dt;
  if (y <= 0) {
    y = 0;
    vy = 0;
  }
  return { y, vy, crouch };
}
