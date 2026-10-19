import { useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { PeerInfo } from "@proto/protocol";
import { INTERPOLATION_DELAY_MS, peerBuffers, serverNow } from "../net/connection";
import { Avatar } from "./Avatar";
import { EYE_HEIGHT, eyeHeightFor } from "./movement";

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
    head.position.y = eye;
    body.scale.y = eye / EYE_HEIGHT;
    tag.position.y = eye + 0.35;
  });

  return <Avatar color={peer.color} name={peer.name} rootRef={rootRef} headRef={headRef} bodyRef={bodyRef} tagRef={tagRef} />;
}
