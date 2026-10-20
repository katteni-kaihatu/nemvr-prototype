import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CrdtSyncInfo, FileObject } from "@proto/protocol";
import { WORLD_SCHEMA_VERSION, WorldDoc, seedDemoBoxes } from "@proto/world-sync";

export interface WorldStoreOptions {
  dir: string;
  actorId?: string;
  log?: (message: string) => void;
  /** 保存をまとめる時間 (テスト用)。 */
  saveDebounceMs?: number;
  /** 保存に失敗したときの再試行の初回待ち時間 (テスト用)。 */
  saveRetryBaseMs?: number;
  /** 保存に失敗したときの再試行の最大待ち時間 (テスト用)。 */
  saveRetryMaxMs?: number;
  /** flush が諦めるまでの時間 (テスト用)。 */
  flushTimeoutMs?: number;
}

interface WorldMeta {
  worldId: string;
  schemaVersion: number;
  createdAt: string;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export const SAVE_DEBOUNCE_MS = 250;
/** 保存に失敗したときの再試行 (指数バックオフ) の初回待ち時間。 */
export const SAVE_RETRY_BASE_MS = 1_000;
/** 保存に失敗したときの再試行の最大待ち時間。 */
export const SAVE_RETRY_MAX_MS = 10_000;
/** flush が書き込みを諦めるまでの既定時間 (終了処理が固まらないように)。 */
export const FLUSH_TIMEOUT_MS = 5_000;
const META_FILE = "meta.json";
const DOC_FILE = "doc.bin";

/** 書き込み途中のファイルを正本にしないよう、一時ファイルへ書いて flush してから rename する。 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    // 失敗した一時ファイルを残さない (残すと、次回の起動で「空でないディレクトリ」に見える)
    try {
      await rm(temp, { force: true });
    } catch {
      // 消せなくても、元のエラーを優先する
    }
    throw error;
  }
  // rename をディスクに確定させる (best effort: ディレクトリの fsync に対応していない環境もある)
  try {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // best effort
  }
}

async function readFileIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseMeta(bytes: Uint8Array, metaPath: string): WorldMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`CRDT の保存データが壊れています: ${metaPath} を JSON として読めません`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`CRDT の保存データが壊れています: ${metaPath} の形式が正しくありません`);
  }
  const { worldId, schemaVersion, createdAt } = parsed as Record<string, unknown>;
  if (typeof worldId !== "string" || worldId.length === 0) {
    throw new Error(`CRDT の保存データが壊れています: ${metaPath} の worldId がありません`);
  }
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) <= 0) {
    throw new Error(`CRDT の保存データが壊れています: ${metaPath} の schemaVersion が正しくありません`);
  }
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    throw new Error(`CRDT の保存データが壊れています: ${metaPath} の createdAt がありません`);
  }
  return { worldId, schemaVersion: schemaVersion as number, createdAt };
}

function parseWorld(docBytes: Uint8Array, docPath: string, actorId: string): WorldDoc {
  if (docBytes.length === 0) {
    throw new Error(`CRDT の保存データが壊れています: ${docPath} が空です`);
  }
  let world: WorldDoc;
  try {
    world = WorldDoc.fromUpdate(docBytes, { actorId });
  } catch (error) {
    throw new Error(
      `CRDT の保存データが壊れています: ${docPath} を Yjs 文書として読めません (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  // 初回 open は必ず seed 済み。空の (または初期化前の) 文書を、消えたワールドとして受け入れない
  if (world.doc.getMap<unknown>("meta").get("seeded") !== "v1") {
    world.destroy();
    throw new Error(
      `CRDT の保存データが壊れています: ${docPath} は初期化済みのワールドではありません (seed 情報がありません)`,
    );
  }
  return world;
}

/** 初回起動の判定で無視してよいファイル (一時ファイル・ドットファイル・lost+found)。 */
function isIgnorableEntry(name: string): boolean {
  return name.startsWith(".") || name === "lost+found" || name.includes(".tmp-");
}

/**
 * crdt-v1 のワールド文書 (Yjs) を CRDT_DATA_DIR に保存する。
 *
 * - 初回だけ worldId を採番し、デモのボックスを 1 回だけ seed する
 * - 再起動時は meta.json と doc.bin を読み、壊れている・スキーマが違う場合は
 *   空のワールドを作らずに起動を失敗させる
 * - doc.bin があり meta.json だけが無い場合は、seed 済みの文書なら meta を作り直す
 *   (doc.bin を書いた直後・meta.json を書く前に落ちた場合の復旧)
 * - 保存は debounce し、同時の保存を直列化する。scheduleSave の Promise は、
 *   呼び出し時点の状態を含む snapshot が確定してから解決する
 */
export class WorldStore {
  readonly worldId: string;
  readonly world: WorldDoc;

  private readonly log: (message: string) => void;
  private readonly docPath: string;
  private readonly saveDebounceMs: number;
  private readonly saveRetryBaseMs: number;
  private readonly saveRetryMaxMs: number;
  private readonly flushTimeoutMs: number;
  private readonly unsubscribe: () => void;
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> | null = null;
  private waiters: Waiter[] = [];
  private closed = false;
  /** ディスクに書かれていない変更があるか。 */
  private dirty = false;
  /** 最後に保存が成功した snapshot の state vector。 */
  private durable: Uint8Array;
  /** scheduleSave / 文書更新の通し番号 (保存中に増えた変更を検出する)。 */
  private requestedSeq = 0;
  private changeSeq = 0;
  /** 連続して失敗した回数 (ログを 1 回に抑え、バックオフを決める)。 */
  private failureBurst = 0;

  private constructor(
    dir: string,
    worldId: string,
    world: WorldDoc,
    log: (message: string) => void,
    options: WorldStoreOptions,
  ) {
    this.worldId = worldId;
    this.world = world;
    this.log = log;
    this.docPath = join(dir, DOC_FILE);
    this.saveDebounceMs = options.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
    this.saveRetryBaseMs = options.saveRetryBaseMs ?? SAVE_RETRY_BASE_MS;
    this.saveRetryMaxMs = options.saveRetryMaxMs ?? SAVE_RETRY_MAX_MS;
    this.flushTimeoutMs = options.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
    // 読み込んだ直後の状態はディスクと一致している
    this.durable = world.encodeStateVector();
    // 直接 world を変更した場合も dirty にする (flush が最新状態を書けるように)
    this.unsubscribe = world.onUpdate(() => {
      this.changeSeq++;
      this.dirty = true;
    });
  }

  static async open(options: WorldStoreOptions): Promise<WorldStore> {
    const dir = options.dir;
    const log = options.log ?? ((message) => console.log(`[world-store] ${message}`));
    if (!dir || dir.trim().length === 0) throw new Error("CRDT_DATA_DIR が指定されていません");
    await mkdir(dir, { recursive: true });

    const metaPath = join(dir, META_FILE);
    const docPath = join(dir, DOC_FILE);
    const [metaBytes, docBytes] = await Promise.all([readFileIfExists(metaPath), readFileIfExists(docPath)]);

    if (!metaBytes && !docBytes) {
      // 空のディレクトリだけを「初回」とみなす。一時ファイル・ドットファイル・lost+found は無視する。
      // 他のファイルがあるのに文書が無い場合は、消えた保存データを新しい空のワールドで置き換えない
      const entries = (await readdir(dir)).filter((name) => !isIgnorableEntry(name));
      if (entries.length > 0) {
        throw new Error(
          `CRDT の保存データが見つかりません: ${dir} に meta.json / doc.bin がないため、` +
            "空のワールドで上書きせずに起動を中止します",
        );
      }
      const worldId = randomUUID();
      const actorId = options.actorId ?? `server:${randomUUID()}`;
      const world = new WorldDoc({ actorId });
      seedDemoBoxes(world);
      const update = world.encodeUpdate();
      const meta: WorldMeta = {
        worldId,
        schemaVersion: WORLD_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      };
      await writeFileAtomic(docPath, update);
      await writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
      log(`initialized ${worldId} at ${dir} (${world.count()} object(s))`);
      return new WorldStore(dir, worldId, world, log, options);
    }

    if (!docBytes) {
      throw new Error(
        `CRDT の保存データが不完全です: ${dir} に ${docPath} がありません。` +
          "空のワールドで上書きせずに起動を中止します",
      );
    }

    const actorId = options.actorId ?? `server:${randomUUID()}`;
    if (!metaBytes) {
      // doc.bin を書いた直後に落ちた場合: seed 済みの文書なら meta.json を作り直す。
      // meta.json はあるのに doc.bin が無い場合は従来どおり失敗させる (上で処理済み)
      const world = parseWorld(docBytes, docPath, actorId);
      const meta: WorldMeta = {
        worldId: randomUUID(),
        schemaVersion: WORLD_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      };
      await writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
      log(`recovered missing ${metaPath}; assigned worldId ${meta.worldId}`);
      log(`loaded ${meta.worldId} from ${dir} (${world.count()} object(s))`);
      return new WorldStore(dir, meta.worldId, world, log, options);
    }

    const meta = parseMeta(metaBytes, metaPath);
    if (meta.schemaVersion !== WORLD_SCHEMA_VERSION) {
      throw new Error(
        `CRDT のスキーマが一致しません: ${metaPath} の schemaVersion=${meta.schemaVersion}、` +
          `このサーバーの対応は ${WORLD_SCHEMA_VERSION} です`,
      );
    }
    const world = parseWorld(docBytes, docPath, actorId);

    log(`loaded ${meta.worldId} from ${dir} (${world.count()} object(s))`);
    return new WorldStore(dir, meta.worldId, world, log, options);
  }

  get syncInfo(): CrdtSyncInfo {
    return { mode: "crdt-v1", worldId: this.worldId, schemaVersion: WORLD_SCHEMA_VERSION };
  }

  /** 最後に保存が成功した snapshot の state vector。 */
  durableVector(): Uint8Array {
    return this.durable;
  }

  /** ディスクに書かれていない変更があるか。 */
  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /**
   * 保存を予約する。同じ debounce 期間の呼び出しは 1 回の snapshot にまとめる。
   * 返る Promise は、この呼び出し時点の状態を含む snapshot がディスクに確定すると解決する。
   * 書き込みに失敗した場合は、その回の呼び出しを reject し、次の保存をバックオフで再試行する。
   */
  scheduleSave(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("WorldStore は閉じています"));
    return new Promise<void>((resolve, reject) => {
      this.requestedSeq++;
      this.dirty = true;
      this.waiters.push({ resolve, reject });
      this.armTimer(this.saveDebounceMs);
    });
  }

  /**
   * 予約を待たずに、いまの状態を保存して確定させる (終了処理・テスト用)。
   * 期限までに書けなければ reject する。
   */
  async flush(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.closed) throw new Error("WorldStore は閉じています");
    const deadline = Date.now() + (options.timeoutMs ?? this.flushTimeoutMs);
    this.clearTimer();
    let lastError: unknown = null;
    for (;;) {
      if (this.saving) {
        try {
          await this.saving;
        } catch (error) {
          lastError = error;
        }
      }
      this.clearTimer();
      if (!this.dirty && this.waiters.length === 0) return;

      try {
        await this.runSave();
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      this.clearTimer();
      if (!this.dirty && this.waiters.length === 0) return;
      if (Date.now() >= deadline) {
        throw lastError instanceof Error ? lastError : new Error("保存がタイムアウトしました");
      }
      // 失敗したときだけ、次の試行まで待つ (成功して dirty が残った場合はすぐ書き直す)
      if (lastError !== null) {
        const remaining = Math.max(0, deadline - Date.now());
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.saveRetryBaseMs, remaining)));
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.unsubscribe();
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter.reject(new Error("WorldStore を閉じたため、保存は完了していません"));
    this.world.destroy();
  }

  /** サーバーが保持している (stored) ファイルを CID で探す。 */
  findFileByCid(cid: string): FileObject | undefined {
    for (const object of this.world.getObjects()) {
      if (object.kind === "file" && object.cid === cid && object.stored) return object;
    }
    return undefined;
  }

  fileObjects(): FileObject[] {
    return this.world.getObjects().filter((object): object is FileObject => object.kind === "file");
  }

  /**
   * 再起動後に、もう取得できないはずの file (stored でなく owner が残っている、または offline が
   * 付いていない) を offline にする。取得中の staging がある CID は、成功する可能性があるので触らない。
   */
  normalizeStaleFiles(stagingCids: { has(cid: string): boolean } = new Set()): number {
    let changed = 0;
    for (const object of this.fileObjects()) {
      if (object.stored || stagingCids.has(object.cid)) continue;
      if (object.owner === undefined && object.offline === true) continue;
      this.world.setMetadata(object.id, { offline: true, owner: undefined });
      changed++;
      this.log(`file ${object.cid} had a stale owner after restart; marked offline`);
    }
    return changed;
  }

  /** 接続が切れたピアが owner の、まだ取得できていないファイルを offline にする。 */
  markPeerFilesOffline(peerId: string, stagingCids: { has(cid: string): boolean } = new Set()): number {
    let changed = 0;
    for (const object of this.fileObjects()) {
      if (object.stored || object.owner !== peerId || stagingCids.has(object.cid)) continue;
      this.world.setMetadata(object.id, { offline: true, owner: undefined });
      changed++;
    }
    return changed;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private armTimer(delayMs: number, replace = false): void {
    if (this.closed || this.saving) return;
    if (this.timer) {
      if (!replace) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSave().catch(() => {
        // 失敗は runSave 内でログ・再試行の予約済み
      });
    }, Math.max(0, delayMs));
  }

  private retryDelayMs(): number {
    const exponent = Math.max(0, this.failureBurst - 1);
    return Math.min(this.saveRetryBaseMs * 2 ** exponent, this.saveRetryMaxMs);
  }

  private runSave(): Promise<void> {
    if (this.saving) return this.saving;
    // snapshot は同期的に取る。ここまでに scheduleSave された呼び出しは、この書き込みで確定する
    const waiters = this.waiters.splice(0);
    const requestedSeq = this.requestedSeq;
    const changeSeq = this.changeSeq;
    let update: Uint8Array;
    let vector: Uint8Array;
    try {
      update = this.world.encodeUpdate();
      vector = this.world.encodeStateVector();
    } catch (error) {
      this.dirty = true;
      this.failureBurst++;
      if (this.failureBurst === 1) {
        this.log(
          `save failed: ${error instanceof Error ? error.message : String(error)}; will retry with backoff`,
        );
      }
      for (const waiter of waiters) waiter.reject(error);
      this.armTimer(this.retryDelayMs(), true);
      return Promise.reject(error);
    }

    const task = (async () => {
      let failure: unknown = null;
      try {
        await writeFileAtomic(this.docPath, update);
        this.durable = vector;
        this.failureBurst = 0;
        for (const waiter of waiters) waiter.resolve();
        // 保存中に増えた変更があれば、まだ dirty のまま
        this.dirty = this.requestedSeq > requestedSeq || this.changeSeq > changeSeq;
      } catch (error) {
        failure = error;
        this.dirty = true;
        this.failureBurst++;
        if (this.failureBurst === 1) {
          this.log(
            `save failed: ${error instanceof Error ? error.message : String(error)}; will retry with backoff`,
          );
        }
        for (const waiter of waiters) waiter.reject(error);
      } finally {
        this.saving = null;
      }
      if (failure !== null) {
        this.armTimer(this.retryDelayMs(), true);
        throw failure;
      }
      if (this.dirty || this.waiters.length > 0) this.armTimer(this.saveDebounceMs);
    })();
    this.saving = task;
    return task;
  }
}
