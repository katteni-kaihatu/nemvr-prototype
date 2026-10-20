import { useEffect, useMemo } from "react";
import { PlaneGeometry, type Material } from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";

/** 鏡の大きさ (m) と、置く位置。ワールドの北側 (z = -20) に、スポーンから見えるように立てる。 */
const MIRROR_WIDTH = 10;
const MIRROR_HEIGHT = 5;
const MIRROR_Z = -20;
const MIRROR_BOTTOM = 0.2;

/**
 * 3D 空間の鏡。`enabled` のときだけ、平面リフレクション (Reflector) を作る。
 * OFF のときは、反射のない暗い板を表示する (鏡の場所はそのまま)。
 * 反射はクライアント側だけで行い、他の人には同期しない (各自の ON/OFF)。
 */
export function Mirror({ enabled }: { enabled: boolean }) {
  const reflector = useMemo(() => {
    if (!enabled) return null;
    const geometry = new PlaneGeometry(MIRROR_WIDTH, MIRROR_HEIGHT);
    return new Reflector(geometry, {
      clipBias: 0.003,
      textureWidth: 1024,
      textureHeight: 1024,
      color: 0x94a3b3,
    });
  }, [enabled]);

  // 反映を切り替えたら (OFF にしたら)、レンダーターゲット・ジオメトリ・マテリアルを解放する
  useEffect(() => {
    return () => {
      if (!reflector) return;
      reflector.getRenderTarget().dispose();
      reflector.geometry.dispose();
      (reflector.material as Material).dispose();
    };
  }, [reflector]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // E2E から、反射が有効か (Reflector を作ったか) を確認できるようにする
    (window as unknown as { __mirror: unknown }).__mirror = { enabled, hasReflector: reflector !== null };
  }, [enabled, reflector]);

  return (
    <group position={[0, MIRROR_BOTTOM + MIRROR_HEIGHT / 2, MIRROR_Z]}>
      {/* 枠 */}
      <mesh position={[0, 0, -0.11]}>
        <boxGeometry args={[MIRROR_WIDTH + 0.6, MIRROR_HEIGHT + 0.6, 0.2]} />
        <meshStandardMaterial color="#232833" metalness={0.4} roughness={0.5} />
      </mesh>
      {reflector ? (
        <primitive object={reflector} />
      ) : (
        // OFF: 反射のない、暗いガラス
        <mesh position={[0, 0, 0.002]}>
          <planeGeometry args={[MIRROR_WIDTH, MIRROR_HEIGHT]} />
          <meshStandardMaterial color="#59636f" metalness={0.15} roughness={0.55} />
        </mesh>
      )}
    </group>
  );
}
