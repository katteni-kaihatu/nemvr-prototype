import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, formatBytes } from "@proto/protocol";
import { sniffImageType } from "./images.js";
import { ContentRejected, type Fetched, type FetchLimits } from "./ipfs.js";

export type ContentKind = "image" | "file";

/** ContentStore が使う IPFS ノードの操作 (テストで差し替えられるよう、最小限に絞っている)。 */
export interface ContentBackend {
  fetchVerified(cid: string, limits: FetchLimits): Promise<Fetched>;
  pin(cid: string): Promise<void>;
  unpin(cid: string): Promise<void>;
  gc(): Promise<void>;
}

export interface ContentStoreOptions {
  /** 保持する内容の合計バイト数の上限 (ディスクに置くので、ディスクの空きより十分小さくする) */
  maxTotalBytes: number;
  /** データが届かない状態がこの時間続いたら取得を打ち切る (画像・ファイル) */
  imageIdleTimeoutMs?: number;
  fileIdleTimeoutMs?: number;
  /** 1 回の取得の合計時間の上限 (既定 1 時間) */
  maxTotalMs?: number;
  /** 参照が無くなってから gc するまでの待ち時間 (短時間の連続削除をまとめる) */
  gcDelayMs?: number;
  log?: (message: string) => void;
}

interface Entry {
  size: number;
  head: Uint8Array;
  /** この内容を指しているオブジェクトの数 */
  refs: number;
}

/**
 * ワールドに置かれた画像・ファイルの中身 (CID) を、サーバーで pin して保持する。
 *
 * - 置かれるとき: 取得して検証し (種類ごとのサイズ上限、画像は形式)、合計容量に収まれば pin する
 * - 同じ内容 (CID) を指すオブジェクトが複数あれば、参照を数えて 1 つだけ保持する (複製・同じファイルの再投入)
 * - 最後の参照が無くなったら unpin し、gc でメモリを空ける
 */
export class ContentStore {
  private entries = new Map<string, Entry>();
  private total = 0;
  /** 取得中の内容が使う見込みの容量 (宣言されたサイズの合計)。同時の追加が合計の上限を超えないようにする。 */
  private reserved = 0;
  private inflight = 0;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private gcRunning: Promise<void> | null = null;
  /** unpin を順番に実行するための鎖 (gc は、これが終わってから行う) */
  private unpinChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: ContentBackend,
    private readonly options: ContentStoreOptions,
  ) {}

  get totalBytes(): number {
    return this.total;
  }

  get count(): number {
    return this.entries.size;
  }

  /**
   * 内容を取得・検証して保持する (参照 1 つ分)。既に保持している内容は取得せず、参照だけ増やす。
   * 通らなければ ContentRejected を投げる。
   */
  async add(
    cid: string,
    kind: ContentKind,
    { onProgress }: { onProgress?: (loadedBytes: number, declaredBytes: number) => void } = {},
  ): Promise<{ size: number; head: Uint8Array }> {
    const known = this.entries.get(cid);
    if (known) {
      this.check(kind, known.size, known.head);
      known.refs++;
      return { size: known.size, head: known.head };
    }

    // gc の最中に取得を始めると、取得したばかりの (まだ pin していない) ブロックが消されてしまう
    while (this.gcRunning) await this.gcRunning;
    this.inflight++;
    let reservedBytes = 0;
    try {
      const fetched = await this.backend.fetchVerified(cid, {
        ...this.limitsFor(kind),
        // 取得を始める前 (ルートのブロックが読めた時点) に、宣言されたサイズで容量を予約する。
        // 大きなファイルを取得してから、容量が足りないと分かって捨てることのないようにする
        onDeclaredSize: (declared) => {
          if (this.total + this.reserved + declared > this.options.maxTotalBytes) throw this.capacityError();
          this.reserved += declared;
          reservedBytes = declared;
        },
        onProgress,
      });
      this.check(kind, fetched.size, fetched.head);

      // 同じ内容を同時に取得していた場合、先に終わったほうの登録を使う
      const raced = this.entries.get(cid);
      if (raced) {
        raced.refs++;
        return { size: raced.size, head: raced.head };
      }

      // 予約は宣言サイズの分なので、実測のサイズでも確かめる (自分の予約は、これから登録するので除く)
      if (this.total + (this.reserved - reservedBytes) + fetched.size > this.options.maxTotalBytes) throw this.capacityError();
      // 容量の判定と登録は同期的に行う (pin の待ち時間の間に、同時に始まった別の追加が
      // 同じ容量を二重に使ったり、同じ内容を二重に登録したりしないように)
      this.entries.set(cid, { size: fetched.size, head: fetched.head, refs: 1 });
      this.total += fetched.size;
      try {
        await this.backend.pin(cid);
      } catch (err) {
        this.entries.delete(cid);
        this.total -= fetched.size;
        throw err;
      }
      return { size: fetched.size, head: fetched.head };
    } catch (err) {
      this.scheduleGc(); // 途中まで取得したブロックを片付ける
      throw err;
    } finally {
      this.reserved -= reservedBytes;
      this.inflight--;
    }
  }

  /** 保持している内容の情報 (取得せず、参照も増やさない)。保持していなければ undefined。 */
  known(cid: string): { size: number; head: Uint8Array } | undefined {
    const entry = this.entries.get(cid);
    return entry && { size: entry.size, head: entry.head };
  }

  /**
   * 内容の全部は取得せずに、宣言されたサイズと、先頭の数バイトだけを調べる (大きなファイルを、遅延転送で置くため)。
   * 何も保持せず、容量も使わない。保持している内容なら、取得せずにその情報を返す。
   * 種類ごとの方針 (宣言サイズの上限・画像の形式) は、取得するときと同じように検査する。
   */
  async probe(cid: string, kind: ContentKind): Promise<{ size: number; head: Uint8Array }> {
    const known = this.known(cid);
    if (known) {
      this.check(kind, known.size, known.head);
      return known;
    }
    try {
      const fetched = await this.backend.fetchVerified(cid, { ...this.limitsFor(kind), headOnly: true });
      this.check(kind, fetched.size, fetched.head);
      return fetched;
    } finally {
      this.scheduleGc(); // 調べるために取得した (pin していない) ブロックを片付ける
    }
  }

  /** 複製など、保持している内容を指すオブジェクトが増えた。 */
  retain(cid: string): void {
    const entry = this.entries.get(cid);
    if (entry) entry.refs++;
  }

  /** オブジェクトが削除された。最後の参照なら unpin して、メモリを空ける。 */
  release(cid: string): void {
    const entry = this.entries.get(cid);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.entries.delete(cid);
    this.total -= entry.size;
    this.unpinChain = this.unpinChain
      .then(() => this.backend.unpin(cid))
      .catch((err: unknown) => this.log(`unpin failed for ${cid}: ${String(err)}`));
    this.scheduleGc();
    this.log(`released ${cid} (${formatBytes(entry.size)}); holding ${formatBytes(this.total)} in ${this.entries.size} item(s)`);
  }

  /** 予約済みの gc を、いますぐ実行して終わるのを待つ (テスト・終了処理用)。 */
  async settle(): Promise<void> {
    if (this.gcTimer) {
      clearTimeout(this.gcTimer);
      this.gcTimer = null;
      await this.runGc();
    }
    await this.unpinChain;
    await this.gcRunning;
  }

  private limitsFor(kind: ContentKind): FetchLimits {
    return kind === "image"
      ? {
          maxBytes: MAX_IMAGE_BYTES,
          idleTimeoutMs: this.options.imageIdleTimeoutMs ?? 20_000,
          maxTotalMs: this.options.maxTotalMs,
          tooLargeMessage: `画像が大きすぎます (上限 ${formatBytes(MAX_IMAGE_BYTES)})`,
        }
      : {
          maxBytes: MAX_FILE_BYTES,
          idleTimeoutMs: this.options.fileIdleTimeoutMs ?? 30_000,
          maxTotalMs: this.options.maxTotalMs,
          tooLargeMessage: `ファイルが大きすぎます (上限 ${formatBytes(MAX_FILE_BYTES)})`,
        };
  }

  private capacityError(): ContentRejected {
    return new ContentRejected(
      `サーバーの保存容量の上限に達しました (${formatBytes(this.options.maxTotalBytes)})。不要なものを削除してください`,
    );
  }

  /** 種類ごとの方針。取得済みの内容に対しても同じ検査をする (同じ内容を別の種類として置く場合)。 */
  private check(kind: ContentKind, size: number, head: Uint8Array): void {
    const limits = this.limitsFor(kind);
    if (size > limits.maxBytes) throw new ContentRejected(limits.tooLargeMessage);
    if (kind === "image" && !sniffImageType(head)) {
      throw new ContentRejected("対応していない画像形式です (PNG / JPEG / GIF / WebP)");
    }
  }

  private scheduleGc(): void {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(() => {
      this.gcTimer = null;
      void this.runGc();
    }, this.options.gcDelayMs ?? 1000);
  }

  private async runGc(): Promise<void> {
    await this.unpinChain;
    // 取得中のブロックを消さないよう、取得が終わっていなければ後回しにする
    if (this.inflight > 0 || this.gcRunning) {
      this.scheduleGc();
      return;
    }
    this.gcRunning = (async () => {
      try {
        await this.backend.gc();
      } catch (err) {
        this.log(`gc failed: ${String(err)}`);
      }
    })();
    try {
      await this.gcRunning;
    } finally {
      this.gcRunning = null;
    }
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
