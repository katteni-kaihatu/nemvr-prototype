import { Canvas } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import { useNet } from "../net/connection";
import { useInteraction } from "./interaction";
import { BoxPlane } from "./BoxPlane";
import { CursorDot } from "./CursorDot";
import { DropTarget } from "./DropTarget";
import { FilePlane } from "./FilePlane";
import { ImagePlane } from "./ImagePlane";
import { LocalPlayer } from "./LocalPlayer";
import { ObjectInteraction } from "./ObjectInteraction";
import { RemoteAvatar } from "./RemoteAvatar";
import { RingMenu } from "./RingMenu";

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

        {Object.values(objects).map((o) =>
          o.kind === "file" ? (
            <FilePlane key={o.id} object={o} />
          ) : o.kind === "box" ? (
            <BoxPlane key={o.id} object={o} />
          ) : (
            <ImagePlane key={o.id} object={o} />
          ),
        )}

        <LocalPlayer />
        <DropTarget />
        <ObjectInteraction />
        {Object.values(peers).map((p) => (
          <RemoteAvatar key={p.id} peer={p} />
        ))}
      </Canvas>
      <CursorDot />
      <RingMenu />
      <HUD count={Object.keys(peers).length + 1} />
    </>
  );
}

function HUD({ count }: { count: number }) {
  const self = useNet((s) => s.self);
  const notice = useNet((s) => s.notice);
  const ipfs = useNet((s) => s.ipfs);
  const grabbedId = useInteraction((s) => s.grabbedId);
  const grabMode = useInteraction((s) => s.grabMode);
  const directPeers = useNet((s) => s.directPeers);
  const ipfsLabel =
    { idle: "-", starting: "接続中...", ready: "接続済み", error: "接続失敗" }[ipfs] +
    (ipfs === "ready" ? ` (P2P ${directPeers})` : "");
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
        {self?.name} / 接続中: {count} 人 / IPFS: {ipfsLabel}
      </div>
      <div style={{ opacity: 0.7 }}>クリックで視点操作開始 / WASD で移動 / Space でジャンプ / C (押している間) でしゃがみ / Esc で解除</div>
      <div style={{ opacity: 0.7 }}>ファイルや画像をドロップして配置 (視点操作中は Esc で解除してから)</div>
      <div style={{ opacity: 0.7 }}>中央の点で狙う: 右ボタン長押しでつかむ (つかんだままマウスを上下: 持ち上げ、ホイール: 遠く・近く、E: 移動 / 回転モード) / 中ボタンでメニュー (削除・複製・ダウンロード)</div>
      {grabbedId && (
        <div style={{ color: "#a5d6a7" }}>
          {grabMode === "rotate"
            ? "回転モード: マウスで回す (左右 = 水平 / 上下 = 垂直) / ホイールで遠く・近く / E で移動モードへ"
            : "移動モード: マウスを上下に動かすと持ち上がる / ホイールで遠く・近く / E で回転モードへ"}
        </div>
      )}
      {notice && <div style={{ color: "#ffd180" }}>{notice}</div>}
    </div>
  );
}
