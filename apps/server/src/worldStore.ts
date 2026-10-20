import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { CrdtSyncInfo, FileObject } from "@proto/protocol";
import { WORLD_SCHEMA_VERSION, WorldDoc, seedDemoBoxes } from "@proto/world-sync";

export interface WorldStoreOptions {
  dir: string;
  actorId?: string;
  log?: (message: string) => void;
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
const META_FILE = "meta.json";
const DOC_FILE = "doc.bin";

/** 書き込み途中のファイルを正本にしないよう、一時ファイルへ書いて flush してから rename する。 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
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

/**
 * crdt-v1 のワールド文書 (Yjs) を CRDT_DATA_DIR に保存する。
 *
 * - 初回だけ worldId を採番し、デモのボックスを 1 回だけ seed する
 * - 再起動時は meta.json と doc.bin を読み、壊れている・スキーマが違う場合は
 *   空のワールドを作らずに起動を失敗させる
 * - 保存は debounce し、同時の保存を直列化する。scheduleSave の Promise は、
 *   呼び出し時点の状態を含む snapshot が確定してから解決する
 */
export class WorldStore {
  readonly worldId: string;
  readonly world: WorldDoc;

  private readonly dir: string;
  private readonly log: (message: string) => void;
  private readonly metaPath: string;
  private readonly docPath: string;
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> | null = null;
  private waiters: Waiter[] = [];
  private closed = false;

  private constructor(dir: string, worldId: string, world: WorldDoc, log: (message: string) => void) {
    this.dir = dir;
    this.worldId = worldId;
    this.world = world;
    this.log = log;
    this.metaPath = join(dir, META_FILE);
    this.docPath = join(dir, DOC_FILE);
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
      // 空のディレクトリだけを「初回」とみなす。他のファイルがあるのに文書が無い場合は、
      // 消えた保存データを新しい空のワールドで置き換えない
      const entries = await readdir(dir);
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
      return new WorldStore(dir, worldId, world, log);
    }

    if (!metaBytes || !docBytes) {
      const missing = !metaBytes ? metaPath : docPath;
      throw new Error(
        `CRDT の保存データが不完全です: ${dir} に ${missing} がありません。` +
          "空のワールドで上書きせずに起動を中止します",
      );
    }

    const meta = parseMeta(metaBytes, metaPath);
    if (meta.schemaVersion !== WORLD_SCHEMA_VERSION) {
      throw new Error(
        `CRDT のスキーマが一致しません: ${metaPath} の schemaVersion=${meta.schemaVersion}、` +
          `このサーバーの対応は ${WORLD_SCHEMA_VERSION} です`,
      );
    }
    if (docBytes.length === 0) {
      throw new Error(`CRDT の保存データが壊れています: ${docPath} が空です`);
    }

    const actorId = options.actorId ?? `server:${randomUUID()}`;
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
      throw new Error(
        `CRDT の保存データが壊れています: ${docPath} は初期化済みのワールドではありません (seed 情報がありません)`,
      );
    }

    log(`loaded ${meta.worldId} from ${dir} (${world.count()} object(s))`);
    return new WorldStore(dir, meta.worldId, world, log);
  }

  get syncInfo(): CrdtSyncInfo {
    return { mode: "crdt-v1", worldId: this.worldId, schemaVersion: WORLD_SCHEMA_VERSION };
  }

  /**
   * 保存を予約する。同じ debounce 期間の呼び出しは 1 回の snapshot にまとめる。
   * 返る Promise は、この呼び出し時点の状態を含む snapshot がディスクに確定すると解決する。
   */
  scheduleSave(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("WorldStore は閉じています"));
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.startTimer();
    });
  }

  /** 予約を待たずに、いまの状態を保存して確定させる (終了処理・テスト用)。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.runSave();
    // 保存中に追加された予約も、呼び出し元の flush で確定させる
    while (this.waiters.length > 0 || this.saving) {
      if (this.saving) await this.saving;
      if (this.waiters.length > 0 && !this.saving) await this.runSave();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

  private startTimer(): void {
    if (this.timer || this.saving || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private runSave(): Promise<void> {
    if (this.saving) return this.saving;
    // snapshot は同期的に取る。ここまでに scheduleSave された呼び出しは、この書き込みで確定する
    const waiters = this.waiters.splice(0);
    let update: Uint8Array;
    try {
      update = this.world.encodeUpdate();
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error);
      return Promise.reject(error);
    }

    const task = (async () => {
      try {
        await writeFileAtomic(this.docPath, update);
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        this.log(`save failed: ${error instanceof Error ? error.message : String(error)}`);
        for (const waiter of waiters) waiter.reject(error);
      } finally {
        this.saving = null;
      }
      if (this.waiters.length > 0 && !this.closed) this.startTimer();
    })();
    this.saving = task;
    return task;
  }
}
