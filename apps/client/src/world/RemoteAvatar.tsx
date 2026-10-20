import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Quaternion, Vector3, type Group } from "three";
import type { PeerInfo, Pose } from "@proto/protocol";
import { INTERPOLATION_DELAY_MS, peerBuffers, serverNow } from "../net/connection";
import { Avatar } from "./Avatar";
import { EYE_HEIGHT, eyeHeightFor, leanPose } from "./movement";
import { VrmAvatar, type VrmAvatarHandle } from "./VrmAvatar";

const RIGHT = new Vector3();
const FORWARD = new Vector3();
const TILT = new Quaternion();

interface DebugAvatarState {
  cid: string | null;
  loaded: boolean;
  error: string | null;
  position?: [number, number, number];
}

// 開発時のみ: E2E テストから、ピアごとの VRM の状態を見られるようにする
const debugAvatars: Record<string, DebugAvatarState> = {};
if (import.meta.env.DEV) {
  (window as unknown as { __avatars?: Record<string, DebugAvatarState> }).__avatars = debugAvatars;
}

/** 他ユーザー 1 人分。姿勢は毎フレーム ref に直接書き込む (React state にしない)。 */
export function RemoteAvatar({ peer }: { peer: PeerInfo }) {
  const rootRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const tagRef = useRef<Group>(null);
  const vrmRef = useRef<VrmAvatarHandle>(null);
  const poseRef = useRef<Pose | null>(null);

  const cid = peer.avatarCid;
  const [vrmLoadedCid, setVrmLoadedCid] = useState<string | null>(null);
  const [vrmError, setVrmError] = useState<{ cid: string | null; message: string } | null>(null);

  const handleLoadedChange = useCallback(
    (loaded: boolean) => {
      setVrmLoadedCid(loaded ? (cid ?? null) : null);
      if (loaded) setVrmError(null);
      else setVrmError((prev) => (prev && prev.cid === (cid ?? null) ? null : prev));
    },
    [cid],
  );

  const handleVrmError = useCallback(
    (error: Error) => {
      setVrmError({ cid: cid ?? null, message: error.message });
    },
    [cid],
  );

  // 最初の姿勢を受け取るまでは原点に出さない
  useLayoutEffect(() => {
    if (rootRef.current) rootRef.current.visible = false;
  }, []);

  // VRM が表示できている間は、簡易アバターの体と頭を隠す (名前タグは残す)
  useEffect(() => {
    const body = bodyRef.current;
    const head = headRef.current;
    if (!body || !head) return;
    const hideSimple = Boolean(cid) && vrmLoadedCid === cid;
    body.visible = !hideSimple;
    head.visible = !hideSimple;
    return () => {
      body.visible = true;
      head.visible = true;
    };
  }, [cid, vrmLoadedCid]);

  // 開発時のみ: ピアごとの状態を window.__avatars に反映する
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    debugAvatars[peer.id] = {
      cid: cid ?? null,
      loaded: Boolean(cid) && vrmLoadedCid === cid,
      error: vrmError && vrmError.cid === (cid ?? null) ? vrmError.message : null,
    };
  }, [peer.id, cid, vrmLoadedCid, vrmError]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return () => {
      delete debugAvatars[peer.id];
    };
  }, [peer.id]);

  useFrame((_state, delta) => {
    const now = serverNow();
    const buf = peerBuffers.get(peer.id);
    const root = rootRef.current;
    const head = headRef.current;
    const body = bodyRef.current;
    const tag = tagRef.current;
    if (now === null || !buf || !root || !head || !body || !tag) return;
    const pose = buf.sample(now - INTERPOLATION_DELAY_MS);
    if (!pose) return;
    poseRef.current = pose;
    root.visible = true;
    root.position.set(...pose.position);
    head.quaternion.set(...pose.head);
    // しゃがむと、頭が下がり、胴体が縮み、名前タグも頭に付いてくる
    const eye = eyeHeightFor(pose.crouch ?? 0);
    body.scale.y = eye / EYE_HEIGHT;
    // リーン: 体が足元を中心に、視線の前方の軸のまわりに傾き、頭が視線の右方向へずれる
    const lean = leanPose(eye, pose.lean ?? 0);
    RIGHT.set(1, 0, 0).applyQuaternion(head.quaternion);
    RIGHT.y = 0;
    if (RIGHT.lengthSq() < 1e-6) RIGHT.set(1, 0, 0);
    RIGHT.normalize();
    FORWARD.set(RIGHT.z, 0, -RIGHT.x); // 右を水平に 90 度回した、前方
    body.quaternion.copy(TILT.setFromAxisAngle(FORWARD, lean.roll));
    head.position.set(RIGHT.x * lean.side, lean.height, RIGHT.z * lean.side);
    tag.position.set(head.position.x, head.position.y + 0.35, head.position.z);

    // 開発時のみ: E2E テストから、アバターが追従していることを確かめられるようにする
    if (import.meta.env.DEV) {
      const debug = debugAvatars[peer.id];
      if (debug) debug.position = [...pose.position];
    }

    vrmRef.current?.applyPose(pose, delta);
  });

  return (
    <>
      <Avatar color={peer.color} name={peer.name} rootRef={rootRef} headRef={headRef} bodyRef={bodyRef} tagRef={tagRef} />
      {cid ? (
        <VrmAvatar
          ref={vrmRef}
          cid={cid}
          poseRef={poseRef}
          onLoadedChange={handleLoadedChange}
          onError={handleVrmError}
        />
      ) : null}
    </>
  );
}
