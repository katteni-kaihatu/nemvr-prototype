import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import { Euler, Quaternion, Vector3, type Group, type Object3D } from "three";
import {
  VRMUtils,
  type VRM,
  type VRMHumanBoneName,
} from "@pixiv/three-vrm";
import type { Pose } from "@proto/protocol";
import { EYE_HEIGHT, LEAN_ANGLE, eyeHeightFor } from "./movement";
import { loadVrm, releaseVrm } from "./vrmModels";

/** VRM 1.0 は +Z 向き。このアプリのアバターは -Z 向きなので、180 度回す。 */
const MODEL_YAW_OFFSET = Math.PI;
/** 首を曲げる上限 (rad)。 */
const MAX_HEAD_PITCH = 1.2;
/** T ポーズから A ポーズへ下ろす角度 (rad)。 */
const A_POSE_ANGLE = 0.9;
/** ひじの曲げ (rad)。 */
const ELBOW_BEND = 0.18;
/**
 * しゃがみで、目の高さの低下のうち、腰を下げる割合。
 * 簡易アバターは胴体を縮めるが、VRM は縮めずに脚を曲げるので、そのまま下げると腰が低くなりすぎる。
 */
const CROUCH_HIP_FACTOR = 0.7;

/** 歩行の 1 周期 (2 歩) の距離 (m)。この距離ごとに、脚の振りが 1 周する。 */
const STRIDE_LENGTH = 1.4;
/** 歩行の脚の振り (rad)。 */
const WALK_THIGH = 0.45;
/** 歩行の膝の曲げ (rad)。 */
const WALK_KNEE = 0.5;
/** 歩行の腕の振り (rad)。 */
const WALK_ARM = 0.28;
/** 歩行の上下動 (m)。 */
const WALK_BOB = 0.02;
/** 歩行の背骨のひねり (rad)。 */
const WALK_SPINE_YAW = 0.05;
/** 待機中の呼吸 (背骨の前後の傾き, rad)。 */
const IDLE_BREATH = 0.018;
/** 待機中の頭の微動 (rad)。 */
const IDLE_HEAD = 0.035;

const HEAD_QUATERNION = new Quaternion();
const HEAD_EULER = new Euler(0, 0, 0, "YXZ");
const HEAD_LOCAL_EULER = new Euler(0, 0, 0, "YXZ");

interface Leg {
  upper: Object3D | null;
  lower: Object3D | null;
  foot: Object3D | null;
}

interface Arm {
  upper: Object3D | null;
  lower: Object3D | null;
  /** 腕が伸びている向き (+1 = +X、-1 = -X)。A ポーズへ下ろす向きを決める。 */
  side: number;
}

interface Rig {
  head: Object3D | null;
  spine: Object3D | null;
  hips: Object3D | null;
  leftLeg: Leg;
  rightLeg: Leg;
  leftArm: Arm;
  rightArm: Arm;
  /** `hips` の初期の高さ (足元から)。 */
  hipsRestY: number;
  /** 股関節から足首までの、初期の高さ。 */
  hipHeight: number;
  thighLength: number;
  shinLength: number;
  /**
   * モデルの正面。VRM 1.0 は +Z なので +1、VRM 0.x は -Z なので -1。
   * (VRM 0.x はシーンを 180 度回して向きをそろえるが、ボーンのローカル軸は元のまま)
   */
  facing: number;
}

/** 待機 / 歩行のアニメーションの状態 (ピアごと)。 */
interface Motion {
  idleTime: number;
  phase: number;
  /** 平滑化した移動速度 (m/s) */
  speed: number;
  /** 歩行の混ぜ具合 (0 = 待機、1 = 歩行) */
  walk: number;
  lastX: number;
  lastZ: number;
  hasLast: boolean;
}

function createMotion(): Motion {
  return { idleTime: 0, phase: 0, speed: 0, walk: 0, lastX: 0, lastZ: 0, hasLast: false };
}

function addLegMotion(leg: Leg, thigh: number, knee: number): void {
  if (leg.upper) leg.upper.rotation.x += thigh;
  if (leg.lower) leg.lower.rotation.x += knee;
}

function addArmMotion(arm: Arm, angle: number): void {
  if (arm.upper) arm.upper.rotation.x += angle;
}

function getBone(vrm: VRM, name: VRMHumanBoneName): Object3D | null {
  return vrm.humanoid.getNormalizedBoneNode(name);
}

function worldPosition(node: Object3D | null, out: Vector3): Vector3 | null {
  return node ? node.getWorldPosition(out) : null;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function buildRig(vrm: VRM): Rig {
  const hips = getBone(vrm, "hips");
  const head = getBone(vrm, "head");
  const spine = getBone(vrm, "spine") ?? getBone(vrm, "chest") ?? getBone(vrm, "upperChest");

  const leftUpperLeg = getBone(vrm, "leftUpperLeg");
  const leftLowerLeg = getBone(vrm, "leftLowerLeg");
  const leftFoot = getBone(vrm, "leftFoot");
  const rightUpperLeg = getBone(vrm, "rightUpperLeg");
  const rightLowerLeg = getBone(vrm, "rightLowerLeg");
  const rightFoot = getBone(vrm, "rightFoot");

  const leftUpperArm = getBone(vrm, "leftUpperArm");
  const leftLowerArm = getBone(vrm, "leftLowerArm");
  const rightUpperArm = getBone(vrm, "rightUpperArm");
  const rightLowerArm = getBone(vrm, "rightLowerArm");

  // シーンの向き (rotateVRM0) を含めた、足元を原点とする座標で測る
  vrm.scene.updateMatrixWorld(true);
  const a = new Vector3();
  const b = new Vector3();
  const leftHip = worldPosition(leftUpperLeg, a);
  const leftKnee = worldPosition(leftLowerLeg, new Vector3());
  const leftAnkle = worldPosition(leftFoot, new Vector3());
  const rightHip = worldPosition(rightUpperLeg, b);
  const rightKnee = worldPosition(rightLowerLeg, new Vector3());
  const rightAnkle = worldPosition(rightFoot, new Vector3());

  const hipY = [leftHip, rightHip].filter((v): v is Vector3 => v !== null).map((v) => v.y);
  const ankleY = [leftAnkle, rightAnkle].filter((v): v is Vector3 => v !== null).map((v) => v.y);
  const thighLengths: number[] = [];
  const shinLengths: number[] = [];
  if (leftHip && leftKnee) thighLengths.push(leftHip.distanceTo(leftKnee));
  if (rightHip && rightKnee) thighLengths.push(rightHip.distanceTo(rightKnee));
  if (leftKnee && leftAnkle) shinLengths.push(leftKnee.distanceTo(leftAnkle));
  if (rightKnee && rightAnkle) shinLengths.push(rightKnee.distanceTo(rightAnkle));

  const hipYAverage = hipY.length > 0 ? average(hipY) : (hips?.position.y ?? 0.9);
  const ankleYAverage = ankleY.length > 0 ? average(ankleY) : 0;
  const hipHeight = Math.max(0.2, hipYAverage - ankleYAverage);
  const thighLength = thighLengths.length > 0 ? average(thighLengths) : 0.42;
  const shinLength = shinLengths.length > 0 ? average(shinLengths) : 0.42;

  return {
    head,
    spine,
    hips,
    leftLeg: { upper: leftUpperLeg, lower: leftLowerLeg, foot: leftFoot },
    rightLeg: { upper: rightUpperLeg, lower: rightLowerLeg, foot: rightFoot },
    leftArm: { upper: leftUpperArm, lower: leftLowerArm, side: leftUpperArm && leftUpperArm.position.x < 0 ? -1 : 1 },
    rightArm: { upper: rightUpperArm, lower: rightLowerArm, side: rightUpperArm && rightUpperArm.position.x < 0 ? -1 : 1 },
    hipsRestY: hips?.position.y ?? hipHeight,
    hipHeight,
    thighLength,
    shinLength,
    facing: vrm.meta?.metaVersion === "0" ? -1 : 1,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function applyLeg(leg: Leg, thighAngle: number, kneeAngle: number, facing: number): void {
  // 太ももを前に倒し、すねを曲げる。足首は、すねの回転を打ち消して地面と平行に保つ
  leg.upper?.rotation.set(-facing * thighAngle, 0, 0);
  leg.lower?.rotation.set(facing * kneeAngle, 0, 0);
  leg.foot?.rotation.set(facing * (thighAngle - kneeAngle), 0, 0);
}

function applyArm(arm: Arm, facing: number): void {
  // T ポーズ (±X 方向) から、体の横へ下ろす
  arm.upper?.rotation.set(0, 0, -arm.side * A_POSE_ANGLE);
  // ひじを少し曲げる。正面 (+Z) 側へ曲がる向き
  arm.lower?.rotation.set(0, -facing * arm.side * ELBOW_BEND, 0);
}

function applyPoseToVrm(vrm: VRM, group: Group, rig: Rig, pose: Pose, delta: number, motion: Motion): void {
  const dt = Math.min(0.05, Math.max(0.001, delta));
  // 姿勢の位置変化から、移動速度を推定する (テレポートのように大きく飛んだフレームは除く)
  const x = pose.position[0];
  const z = pose.position[2];
  let distance = 0;
  if (motion.hasLast) {
    const d = Math.hypot(x - motion.lastX, z - motion.lastZ);
    if (d < 0.5) distance = d;
  }
  motion.lastX = x;
  motion.lastZ = z;
  motion.hasLast = true;
  motion.speed += (distance / dt - motion.speed) * (1 - Math.exp(-10 * dt));
  const targetWalk = clamp((motion.speed - 0.25) / 2, 0, 1);
  motion.walk += (targetWalk - motion.walk) * (1 - Math.exp(-8 * dt));
  motion.phase += (distance / STRIDE_LENGTH) * Math.PI * 2;
  motion.idleTime += dt;

  group.position.set(...pose.position);

  const [qx, qy, qz, qw] = pose.head;
  HEAD_QUATERNION.set(qx, qy, qz, qw);
  HEAD_EULER.setFromQuaternion(HEAD_QUATERNION, "YXZ");

  // 体の向き (yaw) はグループが受け持つ。モデルの正面をこのアプリの -Z に合わせる
  group.rotation.set(0, HEAD_EULER.y + MODEL_YAW_OFFSET, 0);

  const pitch = clamp(HEAD_EULER.x, -MAX_HEAD_PITCH, MAX_HEAD_PITCH);
  if (rig.head) {
    // モデルの正面が +Z か -Z かで、首を振る向きが逆になる
    // 待機中は、頭をわずかに揺らす
    const idle = 1 - motion.walk;
    const idlePitch = Math.sin(motion.idleTime * 1.3) * IDLE_HEAD * 0.5 * idle;
    const idleYaw = Math.sin(motion.idleTime * 0.7) * IDLE_HEAD * idle;
    HEAD_LOCAL_EULER.set(-rig.facing * pitch + idlePitch, idleYaw, -rig.facing * HEAD_EULER.z, "YXZ");
    rig.head.quaternion.setFromEuler(HEAD_LOCAL_EULER);
  }

  // しゃがみ: 目の高さの低下から、腰を下げる量を決める。
  // 脚の長さから、足首が地面から浮かない・沈まない 2 関節の解を求める (前後に曲げるだけの簡易 IK)。
  const crouch = clamp(pose.crouch ?? 0, 0, 1);
  const drop = (EYE_HEIGHT - eyeHeightFor(crouch)) * CROUCH_HIP_FACTOR;
  const thigh = rig.thighLength;
  const shin = rig.shinLength;
  if (drop > 1e-4 && thigh > 1e-4 && shin > 1e-4) {
    const maxReach = thigh + shin;
    const maxHeight = Math.min(rig.hipHeight, maxReach);
    const minHeight = Math.min(maxHeight, Math.max(Math.abs(thigh - shin) + 0.02, 0.12));
    const targetHeight = clamp(rig.hipHeight - drop, minHeight, maxHeight);
    const thighAngle = Math.acos(
      clamp((targetHeight * targetHeight + thigh * thigh - shin * shin) / (2 * targetHeight * thigh), -1, 1),
    );
    const kneeAngle = Math.acos(
      clamp((targetHeight * targetHeight - thigh * thigh - shin * shin) / (2 * thigh * shin), -1, 1),
    );
    applyLeg(rig.leftLeg, thighAngle, kneeAngle, rig.facing);
    applyLeg(rig.rightLeg, thighAngle, kneeAngle, rig.facing);
    if (rig.hips) rig.hips.position.y = rig.hipsRestY - (rig.hipHeight - targetHeight);
  } else {
    applyLeg(rig.leftLeg, 0, 0, rig.facing);
    applyLeg(rig.rightLeg, 0, 0, rig.facing);
    if (rig.hips) rig.hips.position.y = rig.hipsRestY;
  }

  // リーン: 背骨を前後の軸のまわりに傾ける (脚は動かさない)
  const lean = clamp(pose.lean ?? 0, -1, 1);
  if (rig.spine) rig.spine.rotation.set(0, 0, rig.facing * lean * LEAN_ANGLE);

  // 待機姿勢: 腕を下ろす (毎フレーム上書きするので、T ポーズには戻らない)
  applyArm(rig.leftArm, rig.facing);
  applyArm(rig.rightArm, rig.facing);

  // 歩行: 脚と腕を交互に振り、体を少し上下させる。脚が後ろに振れている間は膝を曲げる
  const w = motion.walk;
  const f = rig.facing;
  const swing = Math.sin(motion.phase);
  addLegMotion(rig.leftLeg, -f * swing * WALK_THIGH * w, f * Math.max(0, -swing) * WALK_KNEE * w);
  addLegMotion(rig.rightLeg, f * swing * WALK_THIGH * w, f * Math.max(0, swing) * WALK_KNEE * w);
  addArmMotion(rig.leftArm, f * swing * WALK_ARM * w);
  addArmMotion(rig.rightArm, -f * swing * WALK_ARM * w);
  group.position.y += Math.abs(Math.sin(motion.phase)) * WALK_BOB * w;
  if (rig.spine) rig.spine.rotation.y = f * Math.sin(motion.phase) * WALK_SPINE_YAW * w;

  // 待機: 呼吸で背骨をわずかに動かし、体重を左右に移す
  const idle = 1 - w;
  if (rig.spine) rig.spine.rotation.x = Math.sin(motion.idleTime * 1.6) * IDLE_BREATH * idle;
  if (rig.hips) rig.hips.rotation.z = Math.sin(motion.idleTime * 0.6) * 0.012 * idle;

  vrm.update(delta);
  group.visible = true;
}

export interface VrmAvatarHandle {
  applyPose(pose: Pose, delta: number): void;
}

interface VrmAvatarProps {
  cid: string;
  /** この VRM を描くレイヤー (鏡の中だけで描くときは 1)。省略すると既定のレイヤー */
  layer?: number;
  /** 開発時の確認 (window.__vrmMotion) に使う、このアバターのピア ID */
  peerId?: string;
  /** 直近の姿勢。読み込みが終わった瞬間に、原点に一瞬出ないよう使う。 */
  poseRef: RefObject<Pose | null>;
  onLoadedChange?: (loaded: boolean) => void;
  onError?: (error: Error) => void;
}

/**
 * VRM のアバター。姿勢の適用は、呼び出し側の useFrame から applyPose で行う
 * (補間のタイミングを RemoteAvatar と合わせるため)。
 */
export const VrmAvatar = forwardRef<VrmAvatarHandle, VrmAvatarProps>(function VrmAvatar(
  { cid, layer, peerId, poseRef, onLoadedChange, onError },
  ref,
) {
  const groupRef = useRef<Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const rigRef = useRef<Rig | null>(null);
  const motionRef = useRef<Motion>(createMotion());
  const loadedChangeRef = useRef(onLoadedChange);
  const errorRef = useRef(onError);
  loadedChangeRef.current = onLoadedChange;
  errorRef.current = onError;

  const applyPose = useCallback((pose: Pose, delta: number) => {
    const vrm = vrmRef.current;
    const rig = rigRef.current;
    const group = groupRef.current;
    if (!vrm || !rig || !group) return;
    applyPoseToVrm(vrm, group, rig, pose, delta, motionRef.current);
    if (import.meta.env.DEV && peerId) {
      const motion = motionRef.current;
      const debug = ((window as unknown as { __vrmMotion?: Record<string, unknown> }).__vrmMotion ??= {});
      debug[peerId] = {
        walk: motion.walk,
        phase: motion.phase,
        speed: motion.speed,
        idleTime: motion.idleTime,
        headYaw: HEAD_LOCAL_EULER.y,
        spineX: rig.spine?.rotation.x ?? 0,
        thighX: rig.leftLeg.upper?.rotation.x ?? 0,
      };
    }
  }, [peerId]);

  useImperativeHandle(ref, () => ({ applyPose }), [applyPose]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    let cancelled = false;
    group.visible = false;
    motionRef.current = createMotion();
    loadedChangeRef.current?.(false);

    void loadVrm(cid)
      .then((vrm) => {
        if (cancelled) {
          VRMUtils.deepDispose(vrm.scene);
          return;
        }
        vrmRef.current = vrm;
        rigRef.current = buildRig(vrm);
        if (layer !== undefined) vrm.scene.traverse((object) => object.layers.set(layer));
        group.add(vrm.scene);
        const pose = poseRef.current;
        if (pose) applyPose(pose, 0);
        loadedChangeRef.current?.(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const err = error instanceof Error ? error : new Error(String(error));
        console.warn(`[vrm] ${cid} を読み込めませんでした: ${err.message}`, err);
        loadedChangeRef.current?.(false);
        errorRef.current?.(err);
      });

    return () => {
      cancelled = true;
      const vrm = vrmRef.current;
      vrmRef.current = null;
      rigRef.current = null;
      group.visible = false;
      if (vrm) {
        group.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      // このピアの表示をやめた。最後の 1 人なら、ダウンロードした VRM のバイト列も捨てる
      releaseVrm(cid);
      if (import.meta.env.DEV && peerId) {
        delete (window as unknown as { __vrmMotion?: Record<string, unknown> }).__vrmMotion?.[peerId];
      }
      loadedChangeRef.current?.(false);
    };
  }, [cid, layer, peerId, poseRef, applyPose]);

  return <group ref={groupRef} visible={false} />;
});
