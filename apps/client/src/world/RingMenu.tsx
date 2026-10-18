import { useEffect, type CSSProperties } from "react";
import { formatBytes, type WorldObject } from "@proto/protocol";
import { sendDeleteObject, sendDuplicateObject, useNet } from "../net/connection";
import { downloadObject } from "../net/download";
import { useInteraction } from "./interaction";

interface MenuItem {
  id: string;
  label: string;
  /** 対象のオブジェクトに対して実行する */
  run: (object: WorldObject) => void;
  /** このオブジェクトに出すか (省略すると常に出す) */
  applies?: (object: WorldObject) => boolean;
}

/** リングに並べるボタン。増やすときはここに足す (等間隔に配置される)。 */
const ITEMS: MenuItem[] = [
  { id: "delete", label: "削除", run: (o) => sendDeleteObject(o.id) },
  { id: "duplicate", label: "複製", run: (o) => sendDuplicateObject(o.id) },
  { id: "download", label: "ダウンロード", run: (o) => void downloadObject(o), applies: (o) => o.kind !== "box" },
];

const RING_RADIUS = 108; // 中心からボタンの中心までの距離 (px)
const RING_HALF_WIDTH = 40; // リングの太さの半分 (px)
const START_ANGLE = -90; // 先頭のボタンは真上
const BUTTON_WIDTH = 100;
const BUTTON_HEIGHT = 40;

function closeMenu(): void {
  useInteraction.setState({ menuTargetId: null });
  // メニューを開くときに解除したポインターロックを、クリック (ユーザー操作) の中で取り直す
  void document.querySelector("canvas")?.requestPointerLock();
}

const ringStyle: CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  width: (RING_RADIUS + RING_HALF_WIDTH) * 2,
  height: (RING_RADIUS + RING_HALF_WIDTH) * 2,
  transform: "translate(-50%, -50%)",
  borderRadius: "50%",
  // 中心が空いた円環。中心には、対象の名前とサイズ (または白い点の位置) が見える
  background: `radial-gradient(circle, transparent ${RING_RADIUS - RING_HALF_WIDTH}px, rgba(22, 27, 36, 0.82) ${RING_RADIUS - RING_HALF_WIDTH + 1}px, rgba(22, 27, 36, 0.82) ${RING_RADIUS + RING_HALF_WIDTH - 1}px, transparent ${RING_RADIUS + RING_HALF_WIDTH}px)`,
};

/** 中心に出す、対象の説明 (ファイル名とサイズ)。画像は名前があれば名前を出す。 */
function describe(object: WorldObject): { title: string; detail: string } {
  if (object.kind === "file") {
    // 大きなファイルは、ダウンロードされるまでサーバーに無い (置いた人が配っている)
    const state = object.stored ? "" : object.offline ? " / オフライン" : " / 未転送";
    return { title: object.name, detail: `${formatBytes(object.size)}${state}` };
  }
  if (object.kind === "box") return { title: "ボックス", detail: `${object.size} m` };
  return { title: object.name ?? "画像", detail: "" };
}

/**
 * 中ボタンで開くリング状のコンテキストメニュー。画面中央に出し、ボタンをマウスで選ぶ。
 * 外側のクリック・中ボタン・Esc で閉じる。
 */
export function RingMenu() {
  const targetId = useInteraction((s) => s.menuTargetId);
  const object = useNet((s) => (targetId ? s.objects[targetId] : undefined));

  useEffect(() => {
    if (!targetId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") useInteraction.setState({ menuTargetId: null });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [targetId]);

  if (!targetId || !object) return null;
  const { title, detail } = describe(object);
  const items = ITEMS.filter((item) => item.applies?.(object) ?? true);

  return (
    <div
      data-testid="ring-menu"
      onClick={closeMenu}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeMenu();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", inset: 0, zIndex: 20 }}
    >
      <div style={ringStyle} onClick={(e) => e.stopPropagation()}>
        <div
          data-testid="ring-menu-title"
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: (RING_RADIUS - RING_HALF_WIDTH) * 2 - 24,
            textAlign: "center",
            color: "#ffffff",
            fontSize: 12,
            lineHeight: 1.4,
            // 背後のシーンに重なっても読めるように
            background: "rgba(22, 27, 36, 0.75)",
            borderRadius: 8,
            padding: "3px 6px",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        >
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: "bold" }}>{title}</div>
          {detail && <div style={{ opacity: 0.8 }}>{detail}</div>}
        </div>
        {items.map((item, i) => {
          const angle = ((START_ANGLE + (360 / items.length) * i) * Math.PI) / 180;
          return (
            <button
              key={item.id}
              data-testid={`ring-menu-${item.id}`}
              className="ring-menu-button"
              onClick={() => {
                item.run(object);
                closeMenu();
              }}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: `translate(-50%, -50%) translate(${Math.cos(angle) * RING_RADIUS}px, ${Math.sin(angle) * RING_RADIUS}px)`,
                width: BUTTON_WIDTH,
                height: BUTTON_HEIGHT,
                border: "1px solid rgba(255, 255, 255, 0.35)",
                borderRadius: BUTTON_HEIGHT / 2,
                background: "rgba(48, 56, 72, 0.95)",
                color: "#ffffff",
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
