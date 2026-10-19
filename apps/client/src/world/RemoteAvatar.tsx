import { useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Quaternion, Vector3, type Group } from "three";
import type { PeerInfo } from "@proto/protocol";
import { INTERPOLATION_DELAY_MS, peerBuffers, serverNow } from "../net/connection";
import { Avatar } from "./Avatar";
import { EYE_HEIGHT, eyeHeightFor, leanPose } from "./movement";

const RIGHT = new Vector3();
const FORWARD = new Vector3();
const TILT = new Quaternion();

/** 他ユーザー 1 人分。姿勢は毎フレーム ref に直接書き込む (React state にしない)。 */
export function RemoteAvatar({ peer }: { peer: PeerInfo }) {
  const rootRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const tagRef = useRef<Group>(null);

  // 最初の姿勢を受け取るまでは原点に出さない
  useLayoutEffect(() => {
    if (rootRef.current) rootRef.current.visible = false;
  }, []);

  useFrame(() => {
    const now = serverNow();
    const buf = peerBuffers.get(peer.id);
    const root = rootRef.current;
    const head = headRef.current;
    const body = bodyRef.current;
    const tag = tagRef.current;
    if (now === null || !buf || !root || !head || !body || !tag) return;
    const pose = buf.sample(now - INTERPOLATION_DELAY_MS);
    if (!pose) return;
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
  });

  return <Avatar color={peer.color} name={peer.name} rootRef={rootRef} headRef={headRef} bodyRef={bodyRef} tagRef={tagRef} />;
}
