import type { Pose, Quat, Vec3 } from "@proto/protocol";

export interface Sample {
  time: number; // サーバー時刻 (ms)
  pose: Pose;
}

const MAX_SAMPLES = 20;

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  // 最短経路を通る
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (dot > 0.9995) {
    // ほぼ同じ向き: 線形補間 + 正規化
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(dot);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  const x = a[0] * s0 + bx * s1;
  const y = a[1] * s0 + by * s1;
  const z = a[2] * s0 + bz * s1;
  const w = a[3] * s0 + bw * s1;
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const crouchA = a.crouch ?? 0;
  const crouchB = b.crouch ?? 0;
  const leanA = a.lean ?? 0;
  const leanB = b.lean ?? 0;
  return {
    position: lerpVec3(a.position, b.position, t),
    head: slerpQuat(a.head, b.head, t),
    crouch: crouchA + (crouchB - crouchA) * t,
    lean: leanA + (leanB - leanA) * t,
  };
}

/** サーバー時刻付きの姿勢履歴。renderTime における姿勢を補間して返す。 */
export class PoseBuffer {
  private samples: Sample[] = [];

  push(time: number, pose: Pose): void {
    const last = this.samples[this.samples.length - 1];
    if (last && time <= last.time) return; // 逆転・重複は無視
    this.samples.push({ time, pose });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** 範囲外は外挿せず、最も近い端のサンプルを返す。サンプルが無ければ null。 */
  sample(renderTime: number): Pose | null {
    const s = this.samples;
    const first = s[0];
    const last = s[s.length - 1];
    if (!first || !last) return null;
    if (renderTime <= first.time) return first.pose;
    if (renderTime >= last.time) return last.pose;
    for (let i = s.length - 1; i > 0; i--) {
      const next = s[i]!;
      const prev = s[i - 1]!;
      if (prev.time <= renderTime) {
        const t = (renderTime - prev.time) / (next.time - prev.time);
        return lerpPose(prev.pose, next.pose, t);
      }
    }
    return last.pose;
  }
}
