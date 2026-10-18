import { Canvas } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import { useNet } from "../net/connection";
import { DropTarget } from "./DropTarget";
import { ImagePlane } from "./ImagePlane";
import { LocalPlayer } from "./LocalPlayer";
import { RemoteAvatar } from "./RemoteAvatar";

// 位置関係が分かるように置く静的オブジェクト (同期なし)
const BOXES: { pos: [number, number, number]; size: number; color: string }[] = [
  { pos: [0, 0.5, 0], size: 1, color: "#d9534f" },
  { pos: [6, 1, -4], size: 2, color: "#5bc0de" },
  { pos: [-7, 0.75, -6], size: 1.5, color: "#5cb85c" },
  { pos: [10, 0.5, 8], size: 1, color: "#f0ad4e" },
  { pos: [-10, 1.5, 7], size: 3, color: "#9b59b6" },
];

export function World() {
  const peers = useNet((s) => s.peers);
  const objects = useNet((s) => s.objects);

  return (
    <>
      <Canvas camera={{ fov: 75, near: 0.05, far: 200, position: [0, 1.6, 5] }}>
        <color attach="background" args={["#87a8c9"]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 20, 5]} intensity={1.5} />

        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[50, 50]} />
          <meshStandardMaterial color="#4a5a4a" />
        </mesh>
        <Grid
          args={[50, 50]}
          position={[0, 0.01, 0]}
          cellSize={1}
          sectionSize={5}
          cellColor="#3a483a"
          sectionColor="#9db89d"
          fadeDistance={60}
        />

        {BOXES.map((b, i) => (
          <mesh key={i} position={b.pos}>
            <boxGeometry args={[b.size, b.size, b.size]} />
            <meshStandardMaterial color={b.color} />
          </mesh>
        ))}

        {Object.values(objects).map((o) => (
          <ImagePlane key={o.id} object={o} />
        ))}

        <LocalPlayer />
        <DropTarget />
        {Object.values(peers).map((p) => (
          <RemoteAvatar key={p.id} peer={p} />
        ))}
      </Canvas>
      <HUD count={Object.keys(peers).length + 1} />
    </>
  );
}

function HUD({ count }: { count: number }) {
  const self = useNet((s) => s.self);
  const notice = useNet((s) => s.notice);
  return (
    <div
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        padding: "6px 10px",
        background: "rgba(0,0,0,0.5)",
        borderRadius: 4,
        fontSize: 13,
        pointerEvents: "none",
        lineHeight: 1.5,
      }}
    >
      <div>
        {self?.name} / 接続中: {count} 人
      </div>
      <div style={{ opacity: 0.7 }}>クリックで視点操作開始 / WASD で移動 / Esc で解除</div>
      <div style={{ opacity: 0.7 }}>画像ファイルをドロップして配置 (視点操作中は Esc で解除してから)</div>
      {notice && <div style={{ color: "#ffd180" }}>{notice}</div>}
    </div>
  );
}
