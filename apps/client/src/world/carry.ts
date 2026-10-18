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
