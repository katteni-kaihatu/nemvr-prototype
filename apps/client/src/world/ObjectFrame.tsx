import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import type { Group, Mesh } from "three";
import type { WorldObject } from "@proto/protocol";
import { useNet } from "../net/connection";
import { wrapAngle } from "./carry";
import { carry, useInteraction } from "./interaction";
import { objectMeshes } from "./registry";

/** 他の人が動かしているオブジェクトを、受け取った位置・向きへ近づける速さ (大きいほど速い)。 */
const FOLLOW_RATE = 18;
const HOVER_COLOR = "#ffffff";
const HELD_BY_OTHER_COLOR = "#ffb74d";

interface ObjectFrameProps {
  object: WorldObject;
  /** 板の大きさ (m)。position は下辺中央。 */
  width: number;
  height: number;
  /** 指定すると、板ではなく直方体 (width x height x depth)。position は底面の中央。 */
  depth?: number;
  /** 板に貼るマテリアル (見た目は種類ごとに決める) */
  children: ReactNode;
}

/**
 * 置かれたオブジェクト (画像・ファイル) に共通の枠。鉛直な板として、位置・向きの追従、
 * つかまれている / 狙われている状態の輪郭、当たり判定 (画面中央のレイ) への登録を受け持つ。
 *
 * 位置・向きは props では渡さず、毎フレーム ref に書く。
 * - 自分がつかんでいる間: 手元 (carry) の値をそのまま使う (遅れないように)
 * - それ以外: 受け取った値へ滑らかに近づける (他の人が動かしている間、20Hz の更新でも滑らかに見える)
 */
export function ObjectFrame({ object, width, height, depth, children }: ObjectFrameProps) {
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
    group.rotation.order = "YXZ"; // 水平方向 (yaw) のあとに、垂直方向 (pitch) を傾ける
    group.position.set(...o.position);
    group.rotation.y = o.yaw;
    group.rotation.x = o.pitch ?? 0;
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
      group.rotation.x = carry.pitch;
      return;
    }
    const { position, yaw, pitch = 0 } = latest.current;
    const t = 1 - Math.exp(-FOLLOW_RATE * delta);
    group.position.x += (position[0] - group.position.x) * t;
    group.position.y += (position[1] - group.position.y) * t;
    group.position.z += (position[2] - group.position.z) * t;
    group.rotation.y += wrapAngle(yaw - group.rotation.y) * t;
    group.rotation.x += wrapAngle(pitch - group.rotation.x) * t;
  });

  const outlineColor = heldByOther ? HELD_BY_OTHER_COLOR : hovered ? HOVER_COLOR : null;

  return (
    <group ref={groupRef}>
      <mesh ref={meshRef} position={[0, height / 2, 0]}>
        {depth === undefined ? <planeGeometry args={[width, height]} /> : <boxGeometry args={[width, height, depth]} />}
        {children}
      </mesh>
      {outlineColor && depth !== undefined && (
        <Line
          segments
          points={boxEdges(width, height, depth)}
          color={outlineColor}
          lineWidth={3}
          depthTest={false}
          renderOrder={10}
        />
      )}
      {outlineColor && depth === undefined && (
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

/** 底面の中央を原点とする直方体の 12 本の辺 (線分の端点を 2 つずつ)。 */
function boxEdges(w: number, h: number, d: number): [number, number, number][] {
  const x = w / 2;
  const z = d / 2;
  const corners: [number, number][] = [[-x, -z], [x, -z], [x, z], [-x, z]];
  const points: [number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i]!;
    const [bx, bz] = corners[(i + 1) % 4]!;
    points.push([ax, 0, az], [bx, 0, bz]); // 底面
    points.push([ax, h, az], [bx, h, bz]); // 上面
    points.push([ax, 0, az], [ax, h, az]); // 縦
  }
  return points;
}
