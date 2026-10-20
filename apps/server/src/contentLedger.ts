import { writeFileAtomic } from "./worldStore.js";

export interface ContentLedgerOptions {
  /** null なら保存しない (legacy モード)。 */
  path: string | null;
  /** いまの台帳を JSON に書ける形で返す。 */
  snapshot: () => unknown;
  debounceMs?: number;
  log?: (message: string) => void;
}

export const CONTENT_LEDGER_DEBOUNCE_MS = 500;

/**
 * コンテンツ台帳 (content.json) の保存。500ms の debounce でまとめ、
 * flush() で明示的に確定できる。書き込みは writeFileAtomic で行う。
 */
export class ContentLedger {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;
  private readonly debounceMs: number;

  constructor(private readonly options: ContentLedgerOptions) {
    this.debounceMs = options.debounceMs ?? CONTENT_LEDGER_DEBOUNCE_MS;
  }

  /** 保存を予約する。連続する変更は 1 回の書き込みにまとめる。 */
  schedule(): void {
    if (!this.options.path) return;
    this.dirty = true;
    if (this.timer || this.saving) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save().catch(() => {
        // save 内でログ済み。次に変更があったとき、または flush で再試行する
      });
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** 予約中の保存も含めて、いまの台帳を確定させる。失敗したら reject する。 */
  async flush(): Promise<void> {
    if (!this.options.path) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const inFlight = this.saving;
    let failed = false;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        failed = true;
      }
    }
    if (this.dirty || failed || !inFlight) await this.save();
  }

  private save(): Promise<void> {
    const path = this.options.path;
    if (!path) return Promise.resolve();
    if (this.saving) {
      this.dirty = true;
      return this.saving;
    }
    const task = (async () => {
      do {
        this.dirty = false;
        const data = `${JSON.stringify({ version: 1, entries: this.options.snapshot() }, null, 2)}\n`;
        await writeFileAtomic(path, data);
      } while (this.dirty);
    })();
    this.saving = task
      .catch((error: unknown) => {
        this.options.log?.(
          `台帳を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      })
      .finally(() => {
        this.saving = null;
        if (this.dirty) this.schedule();
      });
    return this.saving;
  }
}
