import type { RefObject } from "react";
import type { Group } from "three";
import { Html } from "@react-three/drei";

export const EYE_HEIGHT = 1.6;

interface AvatarProps {
  color: string;
  name: string;
  /** 足元のワールド位置を受け持つグループ */
  rootRef: RefObject<Group | null>;
  /** 頭の向きを受け持つグループ (前方は -Z) */
  headRef: RefObject<Group | null>;
}

/** 簡易アバター。将来 glTF / VRM に差し替える際はこのコンポーネントに閉じ込める。 */
export function Avatar({ color, name, rootRef, headRef }: AvatarProps) {
  return (
    <group ref={rootRef}>
      <mesh position={[0, 0.7, 0]}>
        <capsuleGeometry args={[0.25, 0.9, 4, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <group ref={headRef} position={[0, EYE_HEIGHT, 0]}>
        <mesh>
          <sphereGeometry args={[0.16, 24, 16]} />
          <meshStandardMaterial color={color} />
        </mesh>
        {/* 目: 前方 (-Z) を示す */}
        <mesh position={[-0.06, 0.03, -0.14]}>
          <sphereGeometry args={[0.03, 8, 8]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        <mesh position={[0.06, 0.03, -0.14]}>
          <sphereGeometry args={[0.03, 8, 8]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      </group>
      <Html position={[0, EYE_HEIGHT + 0.4, 0]} center distanceFactor={8} zIndexRange={[10, 0]}>
        <div
          style={{
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 14,
            whiteSpace: "nowrap",
            userSelect: "none",
            pointerEvents: "none",
          }}
        >
          {name}
        </div>
      </Html>
    </group>
  );
}
