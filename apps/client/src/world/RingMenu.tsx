import { useEffect, type CSSProperties } from "react";
import { sendDeleteObject, sendDuplicateObject } from "../net/connection";
import { useInteraction } from "./interaction";

interface MenuItem {
  id: string;
  label: string;
  /** 対象のオブジェクト ID に対して実行する */
  run: (objectId: string) => void;
}

/** リングに並べるボタン。増やすときはここに足す (等間隔に配置される)。 */
const ITEMS: MenuItem[] = [
  { id: "delete", label: "削除", run: sendDeleteObject },
  { id: "duplicate", label: "複製", run: sendDuplicateObject },
];

const RING_RADIUS = 96; // 中心からボタンの中心までの距離 (px)
const RING_HALF_WIDTH = 36; // リングの太さの半分 (px)
const START_ANGLE = -90; // 先頭のボタンは真上

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
  // 中心が空いた円環。中心には白い点 (カーソル) の位置が見える
  background: `radial-gradient(circle, transparent ${RING_RADIUS - RING_HALF_WIDTH}px, rgba(22, 27, 36, 0.82) ${RING_RADIUS - RING_HALF_WIDTH + 1}px, rgba(22, 27, 36, 0.82) ${RING_RADIUS + RING_HALF_WIDTH - 1}px, transparent ${RING_RADIUS + RING_HALF_WIDTH}px)`,
};

/**
 * 中ボタンで開くリング状のコンテキストメニュー。画面中央に出し、ボタンをマウスで選ぶ。
 * 外側のクリック・中ボタン・Esc で閉じる。
 */
export function RingMenu() {
  const target = useInteraction((s) => s.menuTargetId);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") useInteraction.setState({ menuTargetId: null });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target]);

  if (!target) return null;

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
        {ITEMS.map((item, i) => {
          const angle = ((START_ANGLE + (360 / ITEMS.length) * i) * Math.PI) / 180;
          return (
            <button
              key={item.id}
              data-testid={`ring-menu-${item.id}`}
              className="ring-menu-button"
              onClick={() => {
                item.run(target);
                closeMenu();
              }}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: `translate(-50%, -50%) translate(${Math.cos(angle) * RING_RADIUS}px, ${Math.sin(angle) * RING_RADIUS}px)`,
                width: 72,
                height: 40,
                border: "1px solid rgba(255, 255, 255, 0.35)",
                borderRadius: 20,
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
