/**
 * つかんだオブジェクトを「自分の水平方向の向き (yaw)」に固定して運ぶための計算。
 *
 * つかんだ瞬間の、カメラから見たオブジェクトの相対位置と向きを覚えておき、
 * 毎フレーム、現在のカメラ位置と yaw から世界座標を求め直す。
 * 視点の上下 (pitch) には追従しない (オブジェクトは鉛直に立ったままで、高さも変わらない)。
 *
 * 座標系は three.js (Y 軸回りの回転 θ で、(x, z) は (x cosθ + z sinθ, -x sinθ + z cosθ) に動く)。
 */

export interface CameraState {
  x: number;
  z: number;
  /** カメラの Y 軸回りの回転 (rad)。0 のとき前方は -Z。 */
  yaw: number;
}

export interface ObjectState {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** カメラの水平な向きから見た、オブジェクトの相対的な位置と向き。 */
export interface Attachment {
  dx: number;
  dz: number;
  y: number;
  dyaw: number;
}

export function attach(camera: CameraState, object: ObjectState): Attachment {
  const wx = object.x - camera.x;
  const wz = object.z - camera.z;
  const cos = Math.cos(camera.yaw);
  const sin = Math.sin(camera.yaw);
  // カメラの yaw を打ち消す回転 (-yaw)
  return {
    dx: wx * cos - wz * sin,
    dz: wx * sin + wz * cos,
    y: object.y,
    dyaw: object.yaw - camera.yaw,
  };
}

export function resolve(attachment: Attachment, camera: CameraState): ObjectState {
  const cos = Math.cos(camera.yaw);
  const sin = Math.sin(camera.yaw);
  return {
    x: camera.x + attachment.dx * cos + attachment.dz * sin,
    y: attachment.y,
    z: camera.z - attachment.dx * sin + attachment.dz * cos,
    yaw: camera.yaw + attachment.dyaw,
  };
}

/** 角度 (rad) の差を -π〜π に丸める。補間で最短の向きに回すために使う。 */
export function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((((angle + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

const MIN_LIFT_DISTANCE = 0.5; // m。近すぎるときも、視点を動かせば高さが動くようにする
const MAX_AIM = 1.5; // rad。視線の仰角の上限 (真上・真下の手前)

/**
 * つかんでいるものの高さを、視点を dPitch (rad) だけ上げた (下げた) 分だけ変えて返す。
 * 目の高さから見たオブジェクトの仰角に dPitch を足して、水平距離 distance のところの高さに直す
 * (視線の先に付いたまま上がる・下がる)。範囲は、床 (0m) から maxHeight まで。
 * 範囲に当たっても、仰角は丸めた高さから求め直すので、視点を戻せばすぐ動き出す。
 */
export function liftedHeight(y: number, distance: number, dPitch: number, eyeHeight: number, maxHeight: number): number {
  const d = Math.max(MIN_LIFT_DISTANCE, distance);
  const aim = Math.max(-MAX_AIM, Math.min(MAX_AIM, Math.atan2(y - eyeHeight, d) + dPitch));
  return Math.max(0, Math.min(maxHeight, eyeHeight + d * Math.tan(aim)));
}

/** つかんだものとの水平距離の範囲 (m)。近すぎると視界を塞ぐ。 */
export const MIN_PULL_DISTANCE = 1;
export const MAX_PULL_DISTANCE = 30;

/**
 * つかんだものを、視線の方向に沿って遠ざける (factor > 1) / 引き寄せる (factor < 1)。
 * 水平距離を factor 倍し、カメラから見た向きと、目の高さから見た仰角は変えない
 * (視線の先に付いたまま近づく・遠ざかる)。距離は MIN_PULL_DISTANCE〜MAX_PULL_DISTANCE の範囲に丸め、
 * 既に範囲の外にあるものは、範囲の方向へだけ動かす。高さは、床 (0m) から maxHeight までに丸める。
 */
export function pulled(
  attachment: Pick<Attachment, "dx" | "dz" | "y">,
  factor: number,
  eyeHeight: number,
  maxHeight: number,
): { dx: number; dz: number; y: number } {
  const old = Math.hypot(attachment.dx, attachment.dz);
  // 真下にあるものは、前方へ押し出す (向きが決まらないので)
  const dirX = old > 1e-6 ? attachment.dx / old : 0;
  const dirZ = old > 1e-6 ? attachment.dz / old : -1;
  // 距離 0 のものは、何倍しても 0 のままなので、遠ざける向きなら、最小の距離まで押し出す
  const scaled = old > 1e-6 ? old * factor : factor > 1 ? MIN_PULL_DISTANCE : 0;
  const next = Math.max(Math.min(MIN_PULL_DISTANCE, old), Math.min(Math.max(MAX_PULL_DISTANCE, old), scaled));
  const aim = Math.atan2(attachment.y - eyeHeight, Math.max(old, 1e-6));
  const y = Math.max(0, Math.min(maxHeight, eyeHeight + next * Math.tan(aim)));
  return { dx: dirX * next, dz: dirZ * next, y };
}
