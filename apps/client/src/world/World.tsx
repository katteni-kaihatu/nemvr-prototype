import { useCallback, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import { useNet } from "../net/connection";
import { useInteraction } from "./interaction";
import { BoxPlane } from "./BoxPlane";
import { CursorDot } from "./CursorDot";
import { DropTarget } from "./DropTarget";
import { FilePlane } from "./FilePlane";
import { ImagePlane } from "./ImagePlane";
import { LocalAvatar } from "./LocalAvatar";
import { LinkPlane } from "./LinkPlane";
import { LocalPlayer } from "./LocalPlayer";
import { Mirror } from "./Mirror";
import { ObjectInteraction } from "./ObjectInteraction";
import { RemoteAvatar } from "./RemoteAvatar";
import { RingMenu } from "./RingMenu";

const MIRROR_KEY = "vr-sns:mirror";

export function World() {
  const peers = useNet((s) => s.peers);
  const objects = useNet((s) => s.objects);

  // 鏡の反射は、このクライアントだけで ON/OFF する (他の人には同期しない)。設定はブラウザに保存する
  const [mirrorEnabled, setMirrorEnabled] = useState(() => {
    try {
      return localStorage.getItem(MIRROR_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const toggleMirror = useCallback(() => {
    setMirrorEnabled((enabled) => {
      const next = !enabled;
      try {
        localStorage.setItem(MIRROR_KEY, next ? "on" : "off");
      } catch {
        // 保存できなくても、切り替えはできる
      }
      return next;
    });
  }, []);
  // ワールド内では、ブラウザ標準のコンテキストメニューを出さない
  // (リンクの近くで右クリックして「貼り付け」を選ぶと、同じ URL がもう 1 つ置かれてしまうため)
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("contextmenu", prevent);
    return () => window.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "KeyM" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      toggleMirror();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMirror]);

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
          ) : o.kind === "link" ? (
            <LinkPlane key={o.id} object={o} />
          ) : (
            <ImagePlane key={o.id} object={o} />
          ),
        )}

        <Mirror enabled={mirrorEnabled} />
        <LocalPlayer />
        <LocalAvatar />
        <DropTarget />
        <ObjectInteraction />
        {Object.values(peers).map((p) => (
          <RemoteAvatar key={p.id} peer={p} />
        ))}
      </Canvas>
      <CursorDot />
      <RingMenu />
      <HUD count={Object.keys(peers).length + 1} mirrorEnabled={mirrorEnabled} onToggleMirror={toggleMirror} />
    </>
  );
}

function HUD({
  count,
  mirrorEnabled,
  onToggleMirror,
}: {
  count: number;
  mirrorEnabled: boolean;
  onToggleMirror: () => void;
}) {
  const self = useNet((s) => s.self);
  const notice = useNet((s) => s.notice);
  const ipfs = useNet((s) => s.ipfs);
  const grabbedId = useInteraction((s) => s.grabbedId);
  const grabMode = useInteraction((s) => s.grabMode);
  const directPeers = useNet((s) => s.directPeers);
  const rtt = useNet((s) => s.rtt);
  const logs = useNet((s) => s.logs);
  const contentSources = useNet((s) => s.contentSources);
  const sourceCounts = Object.values(contentSources).reduce(
    (counts, source) => {
      counts[source] += 1;
      return counts;
    },
    { ipfs: 0, server: 0 },
  );
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
        {self?.name} / 接続中: {count} 人 / IPFS: {ipfsLabel} / RTT: {rtt === null ? "--" : `${rtt} ms`}
      </div>
      <div style={{ opacity: 0.85 }}>
        取得元: IPFS {sourceCounts.ipfs} / サーバー {sourceCounts.server}
      </div>
      <div style={{ opacity: 0.7 }}>クリックで視点操作開始 / WASD で移動 / Shift (押している間) で走る / Space でジャンプ / C・Ctrl (押している間) でしゃがみ / Q・E (押している間) でリーン / Esc で解除</div>
      <div style={{ opacity: 0.7 }}>ファイルや画像をドロップ、または Ctrl+V で URL を貼って配置 (視点操作中は Esc で解除してから)</div>
      <div style={{ opacity: 0.7 }}>M で鏡の反射を ON/OFF (このクライアントだけ)</div>
      <div style={{ opacity: 0.7 }}>中央の点で狙う: 右ボタン長押しでつかむ (つかんだままマウスを上下: 持ち上げ、ホイール: 遠く・近く、Shift+ホイール: 大きさ、E: 移動 / 回転モード) / 中ボタンでメニュー (削除・複製・ダウンロード・動画はその場で再生)</div>
      {grabbedId && (
        <div style={{ color: "#a5d6a7" }}>
          {grabMode === "rotate"
            ? "回転モード: マウスで回す (左右 = 水平 / 上下 = 垂直) / ホイールで遠く・近く / Shift+ホイールで大きさ / E で移動モードへ"
            : "移動モード: マウスを上下に動かすと持ち上がる / ホイールで遠く・近く / Shift+ホイールで大きさ / E で回転モードへ"}
        </div>
      )}
      <button
        data-testid="mirror-toggle"
        onClick={onToggleMirror}
        style={{
          pointerEvents: "auto",
          marginTop: 4,
          padding: "2px 8px",
          fontSize: 12,
          borderRadius: 4,
          border: "1px solid rgba(255,255,255,0.4)",
          background: mirrorEnabled ? "rgba(80,120,90,0.8)" : "rgba(70,70,80,0.8)",
          color: "#ffffff",
          cursor: "pointer",
        }}
      >
        鏡: {mirrorEnabled ? "ON" : "OFF"} (M)
      </button>
      {notice && <div style={{ color: "#ffd180" }}>{notice}</div>}
      {logs.length > 0 && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px solid rgba(255,255,255,0.2)",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.4,
            maxWidth: 680,
            whiteSpace: "pre-wrap",
          }}
        >
          {logs.map((line, index) => (
            <div key={`${index}-${line}`} style={{ opacity: 0.9 }}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
