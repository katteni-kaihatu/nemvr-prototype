/** Ctrl+V / Cmd+V による貼り付けだけを受け付けるための判定。 */

export interface PasteShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** 貼り付けショートカットの keydown か。 */
export function isPasteShortcut(event: PasteShortcutEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "v" || event.key === "V");
}

/**
 * 直前の貼り付けショートカットから許容時間内か。
 *
 * Linux 系ブラウザでは中ボタンで primary selection を貼り付けると、キー操作なしで
 * `paste` イベントが発火する。これを URL 配置として扱わないために、ショートカットの
 * 時刻と突き合わせる。`shortcutAt` が 0 のときはショートカット未検出。
 */
export function shouldHandlePaste(shortcutAt: number, now: number, ttlMs = 1500): boolean {
  if (!Number.isFinite(shortcutAt) || !Number.isFinite(now) || shortcutAt <= 0) return false;
  const elapsed = now - shortcutAt;
  return elapsed >= 0 && elapsed <= ttlMs;
}
