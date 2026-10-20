import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Quaternion, Vector3, type Group } from "three";
import type { Pose } from "@proto/protocol";
import { useNet } from "../net/connection";
import { Avatar } from "./Avatar";
import { LOCAL_AVATAR_LAYER } from "./layers";
import { EYE_HEIGHT, eyeHeightFor, leanPose } from "./movement";
import { localPlayerPose } from "./LocalPlayer";
import { VrmAvatar, type VrmAvatarHandle } from "./VrmAvatar";

const RIGHT = new Vector3();
const FORWARD = new Vector3();
const TILT = new Quaternion();

/**
 * 自分のアバター。一人称のメインカメラには描かず、`LOCAL_AVATAR_LAYER` (1) に置く。
 * 鏡の反射カメラだけがこのレイヤーを描くので、鏡の中にだけ自分が映る。
 * VRM を設定していれば VRM、無ければ簡易アバターを、ローカルの姿勢に合わせて動かす。
 */
export function LocalAvatar() {
  const self = useNet((s) => s.self);
  const camera = useThree((s) => s.camera);
  const wrapperRef = useRef<Group>(null);
  const vrmRef = useRef<VrmAvatarHandle>(null);
  const poseRef = useRef<Pose | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // 簡易アバター用の参照
  const rootRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const tagRef = useRef<Group>(null);

  const cid = self?.avatarCid;

  // アバターが変わったら、読み込み状態を戻す
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [cid]);

  // 自分のアバター全体を、メインカメラが描かないレイヤーへ
  useLayoutEffect(() => {
    wrapperRef.current?.traverse((object) => object.layers.set(LOCAL_AVATAR_LAYER));
  }, [cid, self?.name]);

  // 開発時のみ: E2E から、ローカルアバターの状態と、メインカメラのレイヤーを確認できるようにする
  useLayoutEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __localAvatar: unknown }).__localAvatar = {
        cid: cid ?? null,
        layer: LOCAL_AVATAR_LAYER,
        loaded,
        failed,
        mainCameraLayers: camera.layers.mask,
      };
    }
  }, [cid, loaded, failed, camera]);

  useFrame((_state, delta) => {
    const p = localPlayerPose;
    const pose: Pose = {
      position: [p.x, p.y, p.z],
      head: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
      crouch: p.crouch,
      lean: p.lean,
    };
    poseRef.current = pose;
    vrmRef.current?.applyPose(pose, delta);
    if (cid && !failed) return; // VRM を表示中 (簡易アバターは使わない)

    // 簡易アバター: RemoteAvatar と同じ姿勢の適用
    const root = rootRef.current;
    const head = headRef.current;
    const body = bodyRef.current;
    const tag = tagRef.current;
    if (!root || !head || !body || !tag) return;
    root.visible = true;
    root.position.set(...pose.position);
    head.quaternion.set(...pose.head);
    const eye = eyeHeightFor(pose.crouch ?? 0);
    body.scale.y = eye / EYE_HEIGHT;
    const lean = leanPose(eye, pose.lean ?? 0);
    RIGHT.set(1, 0, 0).applyQuaternion(head.quaternion);
    RIGHT.y = 0;
    if (RIGHT.lengthSq() < 1e-6) RIGHT.set(1, 0, 0);
    RIGHT.normalize();
    FORWARD.set(RIGHT.z, 0, -RIGHT.x);
    body.quaternion.copy(TILT.setFromAxisAngle(FORWARD, lean.roll));
    head.position.set(RIGHT.x * lean.side, lean.height, RIGHT.z * lean.side);
    tag.position.set(head.position.x, head.position.y + 0.35, head.position.z);
  });

  return (
    <group ref={wrapperRef}>
      {cid && !failed ? (
        <VrmAvatar
          ref={vrmRef}
          cid={cid}
          layer={LOCAL_AVATAR_LAYER}
          poseRef={poseRef}
          onLoadedChange={setLoaded}
          onError={() => setFailed(true)}
        />
      ) : self ? (
        <Avatar
          color={self.color}
          name={self.name}
          rootRef={rootRef}
          headRef={headRef}
          bodyRef={bodyRef}
          tagRef={tagRef}
        />
      ) : null}
    </group>
  );
}
