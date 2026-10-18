import { useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { PeerInfo } from "@proto/protocol";
import { INTERPOLATION_DELAY_MS, peerBuffers, serverNow } from "../net/connection";
import { Avatar } from "./Avatar";

/** 他ユーザー 1 人分。姿勢は毎フレーム ref に直接書き込む (React state にしない)。 */
export function RemoteAvatar({ peer }: { peer: PeerInfo }) {
  const rootRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);

  // 最初の姿勢を受け取るまでは原点に出さない
  useLayoutEffect(() => {
    if (rootRef.current) rootRef.current.visible = false;
  }, []);

  useFrame(() => {
    const now = serverNow();
    const buf = peerBuffers.get(peer.id);
    const root = rootRef.current;
    const head = headRef.current;
    if (now === null || !buf || !root || !head) return;
    const pose = buf.sample(now - INTERPOLATION_DELAY_MS);
    if (!pose) return;
    root.visible = true;
    root.position.set(...pose.position);
    head.quaternion.set(...pose.head);
  });

  return <Avatar color={peer.color} name={peer.name} rootRef={rootRef} headRef={headRef} />;
}
