/**
 * 縦方向の動き (ジャンプ・しゃがみ) の計算。描画や入力から切り離して、単体でテストできるようにしている。
 * 地面は y = 0。物の上に立てるかは、当たり判定 (`collision.ts`) が決めて、`grounded` として、この計算に渡す。
 */

/** 立っているときの目の高さ (m)。 */
export const EYE_HEIGHT = 1.6;
/** しゃがみきったときの目の高さ (m)。 */
export const CROUCH_EYE_HEIGHT = 0.9;
/** しゃがんでいるときの、歩く速さの倍率 (しゃがみきったとき)。 */
export const CROUCH_SPEED_FACTOR = 0.5;
/** 走っている (Shift を押している) ときの、歩く速さの倍率。 */
export const SPRINT_SPEED_FACTOR = 2;
/** この深さ以上しゃがんでいると、走れない。 */
const SPRINT_BLOCKED_CROUCH = 0.5;
/** 重力加速度 (m/s^2)。現実より強めにして、ジャンプを軽快にする。 */
export const GRAVITY = 20;
/** ジャンプの初速 (m/s)。頂点の高さは v^2 / (2g) = 0.9m、滞空は約 0.6 秒。 */
export const JUMP_SPEED = 6;
/** 空中で、あと何回ジャンプできるか (1 = 二段ジャンプ)。地面や物の上に立つと、戻る。 */
export const MAX_AIR_JUMPS = 1;
/** しゃがみの深さが目標に近づく速さ (大きいほど速い)。 */
const CROUCH_RATE = 14;
/** しゃがんでいる (この深さ以上) 間は、ジャンプできない。 */
const JUMP_BLOCKED_CROUCH = 0.5;
/** リーンしきったときの、体の傾き (rad)。約 17 度。足元を中心に、体全体が傾くとして扱う。 */
export const LEAN_ANGLE = 0.3;
/** リーンの深さが目標に近づく速さ (大きいほど速い)。 */
const LEAN_RATE = 12;

export interface Vertical {
  /** 足元の高さ (m)。地面にいれば 0、物の上ならその上面の高さ。 */
  y: number;
  /** 上向きの速さ (m/s) */
  vy: number;
  /** しゃがみの深さ。0 = 立っている、1 = しゃがみきっている。 */
  crouch: number;
  /** 地面か、物の上に立っているか (ジャンプを始められるか)。物の上かは、当たり判定が決めて、呼び出し側が入れる。 */
  grounded: boolean;
  /** 空中で、あと何回ジャンプできるか。 */
  airJumps: number;
}

export interface VerticalInput {
  /** ジャンプのキーを押しているか。押し続けると、着地してすぐ、また跳ぶ。 */
  jump: boolean;
  /** ジャンプのキーを、いま押したか (押し始めた瞬間)。空中でのジャンプ (二段ジャンプ) は、押し続けではなく、押し直したときだけ。 */
  jumpPressed: boolean;
  crouch: boolean;
}

export const initialVertical = (): Vertical => ({ y: 0, vy: 0, crouch: 0, grounded: true, airJumps: MAX_AIR_JUMPS });

/** 地面か物の上に立っているか (ジャンプを始められるか)。 */
export const isGrounded = (v: Vertical): boolean => v.grounded;

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

/**
 * 歩く速さの倍率。走っている (Shift) ときは倍にし、しゃがんでいるときは走れない
 * (しゃがみながら Shift を押しても、しゃがみの速さのまま)。
 */
export function moveSpeedFactor(crouch: number, sprinting: boolean): number {
  const c = Math.max(0, Math.min(1, crouch));
  const canSprint = sprinting && c < SPRINT_BLOCKED_CROUCH;
  return speedFactorFor(c) * (canSprint ? SPRINT_SPEED_FACTOR : 1);
}

/**
 * dt 秒ぶん進める。入力は、押されているか。
 * ジャンプは、立っていて、しゃがんでいないときに始まる。空中では、キーを押し直すたびに、残りの回数ぶんだけ、もう一度跳べる (二段ジャンプ)。
 * 返す `grounded` は、地面 (y = 0) に着いたかだけ。物の上に立っているかは、当たり判定のあとで、呼び出し側が上書きする。
 */
export function stepVertical(v: Vertical, input: VerticalInput, dt: number): Vertical {
  // しゃがみは、目標の深さへ滑らかに近づく (空中でもしゃがめる)
  const target = input.crouch ? 1 : 0;
  const crouch = v.crouch + (target - v.crouch) * (1 - Math.exp(-CROUCH_RATE * dt));

  let vy = v.vy;
  // 立っていれば、空中ジャンプの回数が戻る
  let airJumps = v.grounded ? MAX_AIR_JUMPS : v.airJumps;
  const canJump = v.crouch < JUMP_BLOCKED_CROUCH;
  if (v.grounded && input.jump && canJump) {
    vy = JUMP_SPEED;
  } else if (!v.grounded && input.jumpPressed && airJumps > 0 && canJump) {
    vy = JUMP_SPEED; // 空中で、もう一度
    airJumps--;
  }

  vy -= GRAVITY * dt;
  let y = v.y + vy * dt;
  let grounded = false;
  if (y <= 0) {
    y = 0;
    vy = 0;
    grounded = true;
  }
  return { y, vy, crouch, grounded, airJumps };
}

/**
 * リーンの深さ (-1〜1) を、dt 秒ぶん目標へ近づける。direction は、左 = -1、右 = +1、押していなければ 0。
 * 滑らかに傾き、離すと滑らかに戻る。
 */
export function stepLean(lean: number, direction: -1 | 0 | 1, dt: number): number {
  return lean + (direction - lean) * (1 - Math.exp(-LEAN_RATE * dt));
}

/**
 * 体が足元を中心に傾いたときの、頭の位置と、画面 (体) の傾き。
 * eye は、まっすぐ立ったときの目の高さ (しゃがみで変わる)。
 * side は、右向きの横ずれ (m、左へ傾けると負)、height は足元からの高さ (m)、roll は傾き (rad、右へ傾けると正)。
 */
export function leanPose(eye: number, lean: number): { side: number; height: number; roll: number } {
  const roll = Math.max(-1, Math.min(1, lean)) * LEAN_ANGLE;
  return { side: eye * Math.sin(roll), height: eye * Math.cos(roll), roll };
}
