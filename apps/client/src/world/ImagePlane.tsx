import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { DoubleSide, SRGBColorSpace, TextureLoader, type Group, type Mesh, type Texture } from "three";
import type { ImageObject } from "@proto/protocol";
import { useNet } from "../net/connection";
import { getImageUrl } from "../net/ipfs";
import { wrapAngle } from "./carry";
import { carry, useInteraction } from "./interaction";
import { objectMeshes } from "./registry";

/**
 * CID の画像を IPFS から取得してテクスチャにする。
 * 取得前・失敗時は null (例外は投げない)。
 */
function useImageTexture(cid: string): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let disposed = false;
    let loaded: Texture | null = null;
    getImageUrl(cid)
      .then(
        (url) =>
          new Promise<Texture>((resolve, reject) => {
            new TextureLoader().load(url, resolve, undefined, () => reject(new Error("decode failed")));
          }),
      )
      .then((t) => {
        if (disposed) {
          t.dispose();
          return;
        }
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = 8;
        loaded = t;
        setTexture(t);
      })
      .catch((err: unknown) => {
        // 取得失敗時はプレースホルダーのままにする
        console.warn(`[image] ${cid}:`, err);
      });
    return () => {
      disposed = true;
      loaded?.dispose();
    };
  }, [cid]);

  return texture;
}

/** 他の人が動かしているオブジェクトを、受け取った位置・向きへ近づける速さ (大きいほど速い)。 */
const FOLLOW_RATE = 18;
const HOVER_COLOR = "#ffffff";
const HELD_BY_OTHER_COLOR = "#ffb74d";

/**
 * ワールドに置かれた画像。position は下辺中央、鉛直に立ち、法線は +Z を yaw 回したもの。
 *
 * 位置・向きは props では渡さず、毎フレーム ref に書く。
 * - 自分がつかんでいる間: 手元 (carry) の値をそのまま使う (遅れないように)
 * - それ以外: 受け取った値へ滑らかに近づける (他の人が動かしている間、20Hz の更新でも滑らかに見える)
 */
export function ImagePlane({ object }: { object: ImageObject }) {
  const texture = useImageTexture(object.cid);
  const groupRef = useRef<Group>(null);
  const meshRef = useRef<Mesh>(null);
  const latest = useRef(object);
  latest.current = object;

  const selfId = useNet((s) => s.self?.id);
  const hovered = useInteraction((s) => s.hoverId === object.id);
  const heldByOther = !!object.heldBy && object.heldBy !== selfId;

  // 最初の位置は補間せずにそのまま置く (原点から飛んでくるように見えないように)
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const o = latest.current;
    group.position.set(...o.position);
    group.rotation.y = o.yaw;
  }, []);

  // 画面中央のレイとの当たり判定用に登録する
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.userData.objectId = object.id;
    objectMeshes.set(object.id, mesh);
    return () => {
      if (objectMeshes.get(object.id) === mesh) objectMeshes.delete(object.id);
    };
  }, [object.id]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    if (carry.id === latest.current.id) {
      group.position.set(carry.x, carry.y, carry.z);
      group.rotation.y = carry.yaw;
      return;
    }
    const { position, yaw } = latest.current;
    const t = 1 - Math.exp(-FOLLOW_RATE * delta);
    group.position.x += (position[0] - group.position.x) * t;
    group.position.y += (position[1] - group.position.y) * t;
    group.position.z += (position[2] - group.position.z) * t;
    group.rotation.y += wrapAngle(yaw - group.rotation.y) * t;
  });

  const outlineColor = heldByOther ? HELD_BY_OTHER_COLOR : hovered ? HOVER_COLOR : null;
  const { width, height } = object;

  return (
    <group ref={groupRef}>
      <mesh ref={meshRef} position={[0, height / 2, 0]}>
        <planeGeometry args={[width, height]} />
        {/* map の有無でシェーダーが変わるため key で作り直す */}
        <meshBasicMaterial
          key={texture ? "loaded" : "placeholder"}
          map={texture}
          color={texture ? "#ffffff" : "#888888"}
          side={DoubleSide}
          toneMapped={false}
        />
      </mesh>
      {outlineColor && (
        // 狙っている / 他の人がつかんでいることを示す輪郭。他のものに隠れても見えるようにする
        <Line
          points={[
            [-width / 2, 0, 0],
            [width / 2, 0, 0],
            [width / 2, height, 0],
            [-width / 2, height, 0],
            [-width / 2, 0, 0],
          ]}
          color={outlineColor}
          lineWidth={3}
          depthTest={false}
          renderOrder={10}
        />
      )}
    </group>
  );
}
