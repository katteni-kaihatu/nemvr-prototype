import { useInteraction } from "./interaction";

/**
 * 画面中央の小さな白い点。オブジェクトを選ぶためのカーソル。
 * 視点・位置が動いている間と、止まってから数秒間だけ表示する (表示の判定は ObjectInteraction)。
 */
export function CursorDot() {
  const visible = useInteraction((s) => s.cursorVisible);
  return (
    <div
      data-testid="cursor-dot"
      data-visible={visible}
      aria-hidden
      style={{
        position: "fixed",
        left: "50%",
        top: "50%",
        width: 6,
        height: 6,
        marginLeft: -3,
        marginTop: -3,
        borderRadius: "50%",
        background: "#ffffff",
        boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.55)", // 明るい背景でも見えるように
        opacity: visible ? 1 : 0,
        transition: "opacity 0.3s",
        pointerEvents: "none",
      }}
    />
  );
}
