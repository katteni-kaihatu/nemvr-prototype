interface Entry<T> {
  /** この値を参照している数 (VRM を表示しているピアの数) */
  refs: number;
  value?: T;
  pending?: { promise: Promise<T>; controller: AbortController };
}

/**
 * キーごとに 1 つの値を共有し、参照が無くなったら捨てるキャッシュ。
 * 取得中の値の参照が 0 になったら、取得を取り消す (退出したユーザーのアバターを、
 * 最後の 1 人が見終わったあともダウンロードし続けない)。
 */
export class RefCountedCache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(private readonly load: (key: string, signal: AbortSignal) => Promise<T>) {}

  /** 参照を 1 つ増やして、値を返す (取得中なら、その Promise を共有する)。 */
  acquire(key: string): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { refs: 0 };
      this.entries.set(key, entry);
    }
    entry.refs++;
    if (entry.value !== undefined) return Promise.resolve(entry.value);

    if (!entry.pending) {
      const controller = new AbortController();
      const promise = this.load(key, controller.signal).then((value) => {
        // 取得中に全員が退出していたら、保持しない (呼び出し側は取り消し済み)
        const current = this.entries.get(key);
        if (current === entry && entry.refs > 0) entry.value = value;
        return value;
      });
      entry.pending = { promise, controller };
      const clear = () => {
        if (entry.pending?.promise === promise) entry.pending = undefined;
      };
      void promise.then(clear, clear);
    }
    return entry.pending.promise;
  }

  /** 参照を 1 つ減らす。0 になったら、取得を取り消して捨てる。 */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.entries.delete(key);
    entry.pending?.controller.abort();
    entry.value = undefined;
  }

  /** いま保持しているキー (開発時の確認用)。 */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}
