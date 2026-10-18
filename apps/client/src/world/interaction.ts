import { create } from "zustand";

/** 視点・位置が止まってから、中央の白い点 (カーソル) を表示し続ける時間。 */
export const CURSOR_VISIBLE_MS = 3000;

interface InteractionState {
  /** 画面中央が狙っているオブジェクト (ハイライト用)。 */
  hoverId: string | null;
  /** 自分がつかんでいるオブジェクト。 */
  grabbedId: string | null;
  /** リングメニューを開いている対象のオブジェクト。開いていなければ null。 */
  menuTargetId: string | null;
  /** 画面中央の白い点を表示するか。 */
  cursorVisible: boolean;
}

export const useInteraction = create<InteractionState>(() => ({
  hoverId: null,
  grabbedId: null,
  menuTargetId: null,
  cursorVisible: true, // 入室直後も一定時間は表示する
}));

export function resetInteraction(): void {
  useInteraction.setState({ hoverId: null, grabbedId: null, menuTargetId: null, cursorVisible: true });
}

/**
 * つかんでいるオブジェクトの、このクライアントでの現在位置。
 * 毎フレーム更新されるので store (React の state) には載せず、描画側が直接読む。
 */
export const carry = { id: null as string | null, x: 0, y: 0, z: 0, yaw: 0 };

// 開発時のみ、E2E テストやコンソールから状態を確認できるようにする
if (import.meta.env.DEV) {
  (window as unknown as { __interaction: unknown }).__interaction = useInteraction;
}
