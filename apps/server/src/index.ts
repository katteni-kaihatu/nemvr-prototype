import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  EAGER_FILE_MAX_BYTES,
  FILE_FLOAT_HEIGHT,
  MAX_MESSAGE_BYTES,
  MAX_OBJECTS,
  classifyFile,
  formatBytes,
  type FileObject,
  type PlaceFile,
  type PlaceImage,
  type Vec3,
  type WorldObject,
} from "@proto/protocol";
import { ContentStore } from "./content.js";
import { ContentLedger } from "./contentLedger.js";
import { ContentRejected, startIpfs } from "./ipfs.js";
import { mediaType, parseRange } from "./media.js";
import { PlacementQueue } from "./queue.js";
import { Room } from "./room.js";
import { SyncHub, CRDT_MAX_MESSAGE_BYTES } from "./syncHub.js";
import { iceServersFor, turnConfigFromEnv } from "./turn.js";
import { parseClientMessage } from "./validate.js";
import { fetchUrl } from "./urlFetch.js";
import { WorldStore } from "./worldStore.js";

const PORT = Number(process.env.PORT ?? 8080);
const IPFS_PORT = Number(process.env.IPFS_PORT ?? 8081);
// リバースプロキシ (TLS 終端) の背後で動かすときは HOST=127.0.0.1、
// ブラウザから見た libp2p のポートが IPFS_PORT と違う場合は IPFS_PUBLIC_PORT で指定する
const HOST = process.env.HOST ?? "0.0.0.0";
const IPFS_PUBLIC_PORT = Number(process.env.IPFS_PUBLIC_PORT ?? IPFS_PORT);
const PING_INTERVAL_MS = 30_000;
// 通常モード (legacy) は従来どおり。crdt-v1 は専用の保存ディレクトリが必須で、
// 文書・コンテンツ台帳・ブロックストアを CRDT_DATA_DIR の下に隔離する
const SYNC_MODE = process.env.SYNC_MODE ?? "legacy";
if (SYNC_MODE !== "legacy" && SYNC_MODE !== "crdt-v1") {
  console.error(`SYNC_MODE が不正です: ${SYNC_MODE} (legacy または crdt-v1 を指定してください)`);
  process.exit(1);
}
const IS_CRDT = SYNC_MODE === "crdt-v1";
const CRDT_DATA_DIR = process.env.CRDT_DATA_DIR;
if (IS_CRDT && (!CRDT_DATA_DIR || CRDT_DATA_DIR.trim().length === 0)) {
  console.error("SYNC_MODE=crdt-v1 には CRDT_DATA_DIR が必要です (例: CRDT_DATA_DIR=./.crdt-data)");
  process.exit(1);
}
const CRDT_DIR = IS_CRDT ? CRDT_DATA_DIR! : null;
// 画像・ファイルの取り込み (IPFS から取得) の順番待ち。同じ人の分は 1 件ずつ (同じ接続の転送は先着順に処理されるので、
// 並列にすると後ろが飢えてタイムアウトする)、全体では同時にこの件数まで
const MAX_CONCURRENT_VERIFY = 4;
const MAX_PENDING_PER_PEER = 16; // 1 人が順番待ちにできる件数
const QUEUED_HEARTBEAT_MS = 10_000; // 順番待ちの間、本人に状況を知らせる間隔 (クライアントが、配るのをやめないように)
// サーバーが保持する画像・ファイルの合計サイズの上限 (MB)。ディスクに置くので、ディスクの空きより十分小さくする。
// 既定は 20 GiB (2 GiB のファイルを 10 個まで)
const MAX_TOTAL_MB = Number(process.env.CONTENT_MAX_TOTAL_MB ?? 20 * 1024);
// 画像・ファイルの中身 (ブロック) を置くディレクトリ。legacy では起動のたびに空にする (再起動でワールドの状態が消えるので、
// 残しても参照されない)。crdt-v1 では CRDT_DATA_DIR/blocks を既定にして、再起動後も保持する
const BLOCKSTORE_DIR =
  process.env.BLOCKSTORE_DIR ?? (CRDT_DIR ? join(CRDT_DIR, "blocks") : join(tmpdir(), "vr-sns-proto-blocks"));
const CONTENT_LEDGER_PATH = CRDT_DIR ? join(CRDT_DIR, "content.json") : null;
const PROGRESS_INTERVAL_MS = 500; // 取得の進捗を、置いている本人に知らせる間隔

// 接続を受け付ける前に、保存済みの文書を読む (壊れていれば空のワールドを作らずにここで失敗する)
let store: WorldStore | null = null;
if (CRDT_DIR) {
  try {
    store = await WorldStore.open({ dir: CRDT_DIR, log: (message) => console.log(`[world-store] ${message}`) });
  } catch (err) {
    console.error(`CRDT の保存データを開けません: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const ipfs = await startIpfs(IPFS_PORT, {
  host: HOST,
  publicPort: IPFS_PUBLIC_PORT,
  blockstoreDir: BLOCKSTORE_DIR,
  resetBlockstore: !IS_CRDT,
});
// TURN (WebRTC の中継)。TURN_HOST と TURN_SECRET が未設定なら使わない (クライアントは既定の公開 STUN のみ)
const turn = turnConfigFromEnv(process.env);
const room = new Room(ipfs.info, (userId) => iceServersFor(turn, userId), store?.syncInfo);
if (!store) room.seedDemoBoxes(); // legacy: デモ空間のボックス (つかんで動かせる)。crdt では WorldStore が初回だけ seed する
// 置かれた画像・ファイルの中身 (CID) の保持。参照が無くなったら unpin + gc で解放する (crdt では台帳に保存する)
const content = new ContentStore(ipfs, {
  maxTotalBytes: MAX_TOTAL_MB * 1024 * 1024,
  log: (message) => console.log(`[content] ${message}`),
  ...(CONTENT_LEDGER_PATH ? { onChange: () => contentLedger.schedule() } : {}),
});

/** content.json の保存。500ms の debounce と、明示的な flush を提供する。 */
const contentLedger = new ContentLedger({
  path: CONTENT_LEDGER_PATH,
  snapshot: () => content.snapshot(),
  log: (message) => console.warn(`[content] ${message}`),
});

/** 台帳を確定させる。失敗したらエラーを返す (呼び出し側で stored にしない)。 */
async function ensureContentLedger(peerId: string): Promise<boolean> {
  try {
    await contentLedger.flush();
    return true;
  } catch {
    room.sendError(peerId, "コンテンツ台帳を保存できませんでした");
    return false;
  }
}

/** 保存済みのコンテンツ台帳を復元する。壊れていれば黙って空にせず、起動を失敗させる。 */
async function restoreContentLedger(): Promise<void> {
  if (!CONTENT_LEDGER_PATH) return;
  let text: string;
  try {
    text = await readFile(CONTENT_LEDGER_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  let entries: unknown;
  try {
    const parsed = JSON.parse(text) as { entries?: unknown };
    entries = parsed?.entries;
  } catch {
    throw new Error(`コンテンツ台帳が壊れています: ${CONTENT_LEDGER_PATH} を JSON として読めません`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`コンテンツ台帳が壊れています: ${CONTENT_LEDGER_PATH} に entries がありません`);
  }
  await content.restore(entries);
  console.log(`[content] restored ${content.count} item(s) from ${CONTENT_LEDGER_PATH}`);
}

/**
 * 起動時の照合。文書が stored と言っていても、台帳 (とブロックストア) に無ければ
 * 取得待ちに戻す。オブジェクトは削除しない。
 */
function reconcileStoredFiles(): void {
  if (!store) return;
  for (const object of store.fileObjects()) {
    if (!object.stored) continue;
    if (content.known(object.cid)) continue;
    store.world.setMetadata(object.id, { stored: false, offline: true });
    console.warn(`[content] ${object.cid} is marked stored but is missing from the ledger; marked offline`);
  }
}

/** crdt-v1 で、まだ保持していないファイルを取得している最中の内容 (CID ごとに共有する)。 */
const crdtStaging = new Map<string, Set<string>>();

if (store) {
  try {
    await restoreContentLedger();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  reconcileStoredFiles();
  // 前回のプロセスが落ちたときの owner は、もう配れない。取得中の job が無ければ offline にする
  store.normalizeStaleFiles(crdtStaging);
  // reconcile で文書を書き換えた可能性があるので、台帳と文書の両方を確定させる
  void store.scheduleSave().catch((err: unknown) => {
    console.warn("[world-store] 起動時の保存に失敗しました:", err instanceof Error ? err.message : err);
  });
  contentLedger.schedule();
}

const hub = store ? new SyncHub(store, { log: (message) => console.log(`[sync] ${message}`) }) : null;

type CrdtInsertResult = "added" | "duplicate" | "conflict" | "full";

/** 再送された配置か (同じ ID で、同じ種類・同じ内容)。 */
function isSameLogicalObject(a: WorldObject, b: WorldObject): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "image" || a.kind === "file") return "cid" in b && a.cid === b.cid;
  if (a.kind === "link") return "url" in b && a.url === b.url;
  return true;
}

/**
 * crdt-v1 のオブジェクト追加。クライアント生成 ID の再送は冪等に成功させる。
 * 削除済みの ID は復活させない (同じ ID での再作成は禁止)。
 */
function insertCrdtObject(object: WorldObject): CrdtInsertResult {
  if (!store) return "conflict";
  const existing = store.world.getObject(object.id);
  if (existing) return isSameLogicalObject(existing, object) ? "duplicate" : "conflict";
  if (store.world.isDeleted(object.id)) return "conflict";
  if (store.world.count() >= MAX_OBJECTS) return "full";
  return store.world.createObject(object) ? "added" : "conflict";
}

function reportCrdtInsert(peerId: string, result: CrdtInsertResult, label: string): void {
  if (result === "full") room.sendError(peerId, "これ以上オブジェクトを置けません");
  else if (result === "conflict") room.sendError(peerId, `${label}の objectId が既存のオブジェクトと競合しています`);
}


/**
 * 貼られた URL を取得して置く。画像・動画・音声はサーバーで取得して IPFS に入れ、画像/ファイルとして置く。
 * それ以外 (HTML など) は、本文を読まずに URL のリンクとして置く。
 */
function placeFromUrl(peerId: string, url: string, position: Vec3, yaw: number, objectId?: string): void {
  schedule({
    peerKey: peerId,
    notifyQueued: () => {}, // URL の取得は進捗を出さない (クライアントは「取得中」を表示している)
    onFull: () => room.sendError(peerId, "順番待ちが多すぎます。しばらくしてからやり直してください"),
    run: async () => {
      try {
        const fetched = await fetchUrl(url);
        if (fetched.kind === "link") {
          if (store) {
            const result = insertCrdtObject({
              id: objectId ?? randomUUID(),
              kind: "link",
              url: fetched.url,
              position,
              yaw,
            });
            reportCrdtInsert(peerId, result, "リンク");
            if (result === "added" || result === "duplicate") {
              console.log(`[url] ${fetched.url} -> link (${fetched.contentType || "unknown"})`);
            }
            return;
          }
          if (!room.addLink({ url: fetched.url, position, yaw })) {
            room.sendError(peerId, "これ以上オブジェクトを置けません");
            return;
          }
          console.log(`[url] ${fetched.url} -> link (${fetched.contentType || "unknown"})`);
          return;
        }
        if (!fetched.bytes) throw new Error("URL の内容を取得できませんでした");
        const cid = await ipfs.addBytes(fetched.bytes);
        await content.add(cid, fetched.kind === "image" ? "image" : "file");
        // 文書が stored と言う前に、台帳の entry をディスクへ確定させる
        if (!(await ensureContentLedger(peerId))) return;
        if (fetched.kind === "image") {
          if (store) {
            const result = insertCrdtObject({
              id: objectId ?? randomUUID(),
              kind: "image",
              cid,
              name: fetched.name,
              position,
              yaw,
              width: fetched.width ?? 1,
              height: fetched.height ?? 1,
            });
            reportCrdtInsert(peerId, result, "画像");
            if (result === "added" || result === "duplicate") {
              console.log(`[url] ${fetched.url} -> image ${cid} (${fetched.width}x${fetched.height})`);
            }
            return;
          }
          const added = room.addImage({
            cid,
            name: fetched.name,
            position,
            yaw,
            width: fetched.width ?? 1,
            height: fetched.height ?? 1,
          });
          if (!added) {
            content.release(cid);
            room.sendError(peerId, "これ以上オブジェクトを置けません");
            return;
          }
          console.log(`[url] ${fetched.url} -> image ${cid} (${fetched.width}x${fetched.height})`);
        } else {
          if (store) {
            const result = insertCrdtObject({
              id: objectId ?? randomUUID(),
              kind: "file",
              cid,
              name: fetched.name,
              // ファイルのアイコンは、ドロップしたときと同じ高さに浮かせる
              position: [position[0], FILE_FLOAT_HEIGHT, position[2]],
              yaw,
              size: fetched.size,
              category: fetched.kind,
              stored: true,
            });
            reportCrdtInsert(peerId, result, "ファイル");
            if (result === "added" || result === "duplicate") {
              console.log(`[url] ${fetched.url} -> ${fetched.kind} ${cid} (${formatBytes(fetched.size)})`);
            }
            return;
          }
          const added = room.addFile({
            cid,
            name: fetched.name,
            // ファイルのアイコンは、ドロップしたときと同じ高さに浮かせる
            position: [position[0], FILE_FLOAT_HEIGHT, position[2]],
            yaw,
            size: fetched.size,
            category: fetched.kind,
            stored: true,
          });
          if (!added) {
            content.release(cid);
            room.sendError(peerId, "これ以上オブジェクトを置けません");
            return;
          }
          console.log(`[url] ${fetched.url} -> ${fetched.kind} ${cid} (${formatBytes(fetched.size)})`);
        }
      } catch (err) {
        console.warn(`[url] failed for ${url}:`, err instanceof Error ? err.message : err);
        room.sendError(peerId, err instanceof Error ? err.message : "URL を取得できませんでした");
      }
    },
  });
}

/**
 * 動画のストリーミング配信。`GET /media/<cid>` に、ブラウザの `<video>` が送る Range 要求で応える。
 * 指定された範囲だけを IPFS から流すので、全体を取得しなくても再生が始まり、シークもできる。
 * サーバーが保持している (stored) ファイルだけを配る (CID を知っていれば誰でも取得できる。ワールドの状態から見える情報と同じ)。
 */
async function handleMedia(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/media/")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const cid = decodeURIComponent(url.pathname.slice("/media/".length));
  const object = store ? store.findFileByCid(cid) : room.findStoredFile(cid);
  if (!object || object.size <= 0) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }

  const range = parseRange(req.headers.range, object.size);
  if (range === "invalid") {
    res.writeHead(416, { "Content-Range": `bytes */${object.size}` }).end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? object.size - 1;
  res.writeHead(range ? 206 : 200, {
    "Content-Type": mediaType(object.name),
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    // 中身は CID ごとに不変。ただしサーバーが再起動すると消えることがあるので、長くは持たせない
    "Cache-Control": "private, max-age=0",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${object.size}` } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  // 配信の間は、参照を 1 つ増やして、削除されても途中でブロックが消えないようにする
  content.retain(cid);
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    for await (const chunk of ipfs.cat(cid, { offset: start, length: end - start + 1, signal: abort.signal })) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      console.warn(`[media] streaming failed for ${cid}:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) res.writeHead(500);
      else res.destroy();
    }
  } finally {
    content.release(cid);
    res.end();
  }
}

const httpServer = createServer((req, res) => {
  handleMedia(req, res).catch((err: unknown) => {
    console.warn("[media] request failed:", err instanceof Error ? err.message : err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
const wss = new WebSocketServer({
  noServer: true,
  // legacy は従来どおり 4 KiB。crdt-v1 は 1 MiB まで受け付け、大きな更新は sync_part に分ける
  maxPayload: store ? CRDT_MAX_MESSAGE_BYTES : MAX_MESSAGE_BYTES,
});
httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
httpServer.listen(PORT, HOST);
const alive = new WeakSet<WebSocket>();
const placements = new PlacementQueue(MAX_CONCURRENT_VERIFY, MAX_PENDING_PER_PEER);

/** 取得の進捗を、一定の間隔でしか通知しない関数にする。 */
function throttled(send: (loadedBytes: number, declaredBytes: number) => void): (loaded: number, declared: number) => void {
  let last = 0;
  return (loaded, declared) => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    send(loaded, declared);
  };
}

/**
 * 取り込み (IPFS からの取得) を、順番待ちに入れて実行する。待っている間は、状況を知らせ続ける
 * (クライアントは、サーバーの通知が続く間だけ、ファイルを配り続けるので)。
 * peerKey が同じものは 1 件ずつ順に行う (同じ接続の転送は先着順に処理されるので、並列にすると後ろが飢える)。
 */
function schedule(job: {
  peerKey: string;
  run: () => Promise<void>;
  notifyQueued: () => void;
  onFull: () => void;
  onCancel?: () => void;
}): void {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(heartbeat);
  const result = placements.enqueue({
    peerId: job.peerKey,
    run: job.run,
    onStart: stop,
    onCancel: () => {
      stop(); // 順番待ちの間に、取りに行く相手が退室した
      job.onCancel?.();
    },
  });
  if (result === "full") {
    job.onFull();
  } else if (result === "queued") {
    job.notifyQueued();
    heartbeat = setInterval(job.notifyQueued, QUEUED_HEARTBEAT_MS);
  }
}

function reportPlaceError(peerId: string, label: string, kind: string, err: unknown): void {
  if (!(err instanceof ContentRejected)) console.warn(`[place_${kind}] unexpected error:`, err);
  room.sendError(peerId, err instanceof ContentRejected ? err.message : `${label}を置けませんでした`);
}

/** 画像: 中身を取得・検証して pin し、通ったらワールドに置く。画像は全員が表示するので、すぐに取得する。 */
function placeImage(peerId: string, place: PlaceImage): void {
  if (store) {
    placeImageCrdt(peerId, place);
    return;
  }
  if (room.isFull) {
    room.sendError(peerId, "これ以上オブジェクトを置けません");
    return;
  }
  const { cid } = place;
  schedule({
    peerKey: peerId,
    notifyQueued: () => room.sendPlaceProgress(peerId, cid, 0, undefined, true),
    onFull: () => room.sendError(peerId, "順番待ちの画像が多すぎます。いくつか終わってからやり直してください"),
    run: async () => {
      try {
        const fetched = await content.add(cid, "image", {
          onProgress: throttled((loaded, declared) => room.sendPlaceProgress(peerId, cid, loaded, declared)),
        });
        if (room.addImage(place)) {
          console.log(`[place_image] ${cid} (${formatBytes(fetched.size)}) by ${peerId}`);
        } else {
          content.release(cid); // 検証している間に満杯になった
          room.sendError(peerId, "これ以上オブジェクトを置けません");
        }
      } catch (err) {
        reportPlaceError(peerId, "画像", "image", err);
      }
    },
  });
}

/** crdt-v1 の画像配置。objectId があれば再送を冪等に扱い、削除済み ID は復活させない。 */
function placeImageCrdt(peerId: string, place: PlaceImage): void {
  if (!store) return;
  const id = place.objectId ?? randomUUID();
  const existing = store.world.getObject(id);
  if (existing) {
    if (!isSameLogicalObject(existing, { id, kind: "image", cid: place.cid, position: place.position, yaw: place.yaw, width: place.width, height: place.height })) {
      reportCrdtInsert(peerId, "conflict", "画像");
    }
    return;
  }
  if (store.world.isDeleted(id)) {
    reportCrdtInsert(peerId, "conflict", "画像");
    return;
  }
  if (store.world.count() >= MAX_OBJECTS) {
    reportCrdtInsert(peerId, "full", "画像");
    return;
  }
  const { cid } = place;
  schedule({
    peerKey: peerId,
    notifyQueued: () => room.sendPlaceProgress(peerId, cid, 0, undefined, true),
    onFull: () => room.sendError(peerId, "順番待ちの画像が多すぎます。いくつか終わってからやり直してください"),
    run: async () => {
      try {
        const fetched = await content.add(cid, "image", {
          onProgress: throttled((loaded, declared) => room.sendPlaceProgress(peerId, cid, loaded, declared)),
        });
        if (!(await ensureContentLedger(peerId))) return;
        const object: WorldObject = {
          id,
          kind: "image",
          cid,
          position: place.position,
          yaw: place.yaw,
          width: place.width,
          height: place.height,
          ...(place.name ? { name: place.name } : {}),
        };
        const result = insertCrdtObject(object);
        reportCrdtInsert(peerId, result, "画像");
        if (result === "added" || result === "duplicate") {
          console.log(`[place_image] ${cid} (${formatBytes(fetched.size)}) by ${peerId}${result === "duplicate" ? " (already placed)" : ""}`);
        }
        // crdt-v1 では、配置に失敗しても検証済みの内容を unpin しない (明示的リセットまで保持)
      } catch (err) {
        reportPlaceError(peerId, "画像", "image", err);
      }
    },
  });
}

/**
 * ファイル: 置いた時点で、サーバーが取得して保持する (置いた人が、いつ退室するか分からないため)。
 * 小さければ (EAGER_FILE_MAX_BYTES 以下)、全部取得してから置く。
 * 大きければ、宣言サイズと先頭の数バイト (アイコンの種類の判定用) だけを調べて、すぐに置き (`stored: false`)、
 * 続けて、サーバーが全部をバックグラウンドで取得する (stageFile)。取り終えるまで、置いた人のブラウザが配り続ける。
 * ダウンロードする人は、先に直接取得を試し、だめなら `request_file` でこの取得の完了を待つ。
 */
function placeFile(peerId: string, place: PlaceFile): void {
  if (store) {
    placeFileCrdt(peerId, place);
    return;
  }
  if (room.isFull) {
    room.sendError(peerId, "これ以上オブジェクトを置けません");
    return;
  }
  const { cid } = place;
  schedule({
    peerKey: peerId,
    notifyQueued: () => room.sendPlaceProgress(peerId, cid, 0, undefined, true),
    onFull: () => room.sendError(peerId, "順番待ちのファイルが多すぎます。いくつか終わってからやり直してください"),
    run: async () => {
      try {
        // 既にサーバーが保持している内容は、取得せずに、そのまま保持済みとして置く
        const probe = await content.probe(cid, "file");
        const category = classifyFile(place.name, probe.head);
        if (probe.size > EAGER_FILE_MAX_BYTES && !content.known(cid)) {
          if (!room.addFile({ ...place, size: probe.size, category, stored: false, owner: peerId })) {
            room.sendError(peerId, "これ以上オブジェクトを置けません");
            return;
          }
          console.log(`[place_file] ${cid} (${formatBytes(probe.size)}, placed; fetching in the background) by ${peerId}`);
          const object = room.findUnstoredFile(cid);
          if (object) stageFile(null, object);
          return;
        }
        const fetched = await content.add(cid, "file", {
          onProgress: throttled((loaded, declared) => room.sendPlaceProgress(peerId, cid, loaded, declared)),
        });
        // 種類 (アイコン) とサイズは、クライアントの申告ではなく、取得した中身から決める
        if (room.addFile({ ...place, size: fetched.size, category: classifyFile(place.name, fetched.head), stored: true })) {
          console.log(`[place_file] ${cid} (${formatBytes(fetched.size)}) by ${peerId}`);
        } else {
          content.release(cid);
          room.sendError(peerId, "これ以上オブジェクトを置けません");
        }
      } catch (err) {
        reportPlaceError(peerId, "ファイル", "file", err);
      }
    },
  });
}

/** crdt-v1 のファイル配置。小さいものは取得してから、大きいものは先に置いて背景で取得する。 */
function placeFileCrdt(peerId: string, place: PlaceFile): void {
  if (!store) return;
  const id = place.objectId ?? randomUUID();
  const existing = store.world.getObject(id);
  if (existing) {
    if (!isSameLogicalObject(existing, { id, kind: "file", cid: place.cid, name: place.name, position: place.position, yaw: place.yaw, size: 0, stored: false, category: "file" })) {
      reportCrdtInsert(peerId, "conflict", "ファイル");
    }
    return;
  }
  if (store.world.isDeleted(id)) {
    reportCrdtInsert(peerId, "conflict", "ファイル");
    return;
  }
  if (store.world.count() >= MAX_OBJECTS) {
    reportCrdtInsert(peerId, "full", "ファイル");
    return;
  }
  const { cid } = place;
  schedule({
    peerKey: peerId,
    notifyQueued: () => room.sendPlaceProgress(peerId, cid, 0, undefined, true),
    onFull: () => room.sendError(peerId, "順番待ちのファイルが多すぎます。いくつか終わってからやり直してください"),
    run: async () => {
      try {
        // 既にサーバーが保持している内容は、取得せずに、そのまま保持済みとして置く
        const probe = await content.probe(cid, "file");
        const category = classifyFile(place.name, probe.head);
        if (probe.size > EAGER_FILE_MAX_BYTES && !content.known(cid)) {
          const object: WorldObject = {
            id,
            kind: "file",
            cid,
            name: place.name,
            position: place.position,
            yaw: place.yaw,
            size: probe.size,
            category,
            stored: false,
            owner: peerId,
          };
          const result = insertCrdtObject(object);
          reportCrdtInsert(peerId, result, "ファイル");
          if (result === "added" || result === "duplicate") {
            console.log(`[place_file] ${cid} (${formatBytes(probe.size)}, placed; fetching in the background) by ${peerId}`);
            const placed = store!.world.getObject(id);
            if (placed?.kind === "file" && !placed.stored) stageFileCrdt(null, placed);
          }
          return;
        }
        const fetched = await content.add(cid, "file", {
          onProgress: throttled((loaded, declared) => room.sendPlaceProgress(peerId, cid, loaded, declared)),
        });
        // 文書が stored と言う前に、台帳の entry をディスクへ確定させる
        if (!(await ensureContentLedger(peerId))) return;
        // 種類 (アイコン) とサイズは、クライアントの申告ではなく、取得した中身から決める
        const object: WorldObject = {
          id,
          kind: "file",
          cid,
          name: place.name,
          position: place.position,
          yaw: place.yaw,
          size: fetched.size,
          category: classifyFile(place.name, fetched.head),
          stored: true,
        };
        const result = insertCrdtObject(object);
        reportCrdtInsert(peerId, result, "ファイル");
        if (result === "added" || result === "duplicate") {
          console.log(`[place_file] ${cid} (${formatBytes(fetched.size)}) by ${peerId}${result === "duplicate" ? " (already placed)" : ""}`);
        }
        // crdt-v1 では、配置に失敗しても検証済みの内容を unpin しない
      } catch (err) {
        reportPlaceError(peerId, "ファイル", "file", err);
      }
    },
  });
}

/** まだ保持していないファイルを取得している最中の内容 (CID ごと)。ダウンロードを要求して待っている人もここに入る。 */
const staging = new Map<string, Set<string>>();

/**
 * まだ保持していない大きなファイルを、置いた人から全部取得して保持する。置かれた直後に始まり (requesterId = null)、
 * ダウンロードの要求 (`request_file`) があれば、その人も一緒に待つ。
 * 終わると `object_updated` (stored) が全員に配られる。同じ内容の取得は 1 回で、進捗・失敗は待っている人みんなに知らせる。
 * 置いた人にも、進捗を `place_progress` で知らせる。失敗したら、そのファイルは取り除く (置いた人が退室して
 * 「オフライン」になっているものは除く)。
 */
function stageFile(requesterId: string | null, object: FileObject): void {
  const { cid } = object;
  console.log(
    `[stage_file] ${cid} ${requesterId ? `requested by ${requesterId}` : "started at placement"} (stored: ${object.stored}, offline: ${!!object.offline}, owner: ${object.owner ?? "-"})`,
  );
  if (object.stored) return; // もう保持している。要求した人は、object_updated で進む
  if (object.offline || !object.owner) {
    if (requesterId) room.sendPrepareFailed(requesterId, cid, "アップロードした人が退室しているため、取得できません");
    return;
  }
  const waiting = staging.get(cid);
  if (waiting) {
    if (requesterId) waiting.add(requesterId); // 取得中。一緒に待つ
    return;
  }
  const owner = object.owner;
  const waiters = new Set<string>(requesterId ? [requesterId] : []);
  staging.set(cid, waiters);
  const failAll = (message: string) => {
    for (const id of waiters) room.sendPrepareFailed(id, cid, message);
    staging.delete(cid);
    // 保持できなかったファイルは、取得できないまま残さない (ただし、置いた人が退室したものは、オフラインとして残る)
    if (room.removeUnstored(cid) > 0) room.sendError(owner, `${object.name}: ${message}`);
  };
  // 置いた人 (owner) には place_progress、ダウンロードを待っている人には prepare_progress を送る
  const progressTo = (loaded: number, total?: number, queued?: boolean) => {
    room.sendPlaceProgress(owner, cid, loaded, total, queued);
    for (const id of waiters) if (id !== owner) room.sendPrepareProgress(id, cid, loaded, total, queued);
  };

  schedule({
    peerKey: owner, // 取りに行く相手 (置いた人) の接続ごとに、1 件ずつ
    notifyQueued: () => progressTo(0, undefined, true),
    onFull: () => failAll("順番待ちが多すぎます。しばらくしてからやり直してください"),
    onCancel: () => failAll("アップロードした人が退室したため、取得できません"),
    run: async () => {
      const senders = new Map<string, number>();
      try {
        const { size } = await content.add(cid, "file", {
          onProgress: throttled((loaded, declared) => progressTo(loaded, declared)),
          onSender: (peer) => senders.set(peer, (senders.get(peer) ?? 0) + 1),
        });
        const updated = room.markStored(cid, size);
        if (updated.length === 0) content.release(cid); // 取得している間に、すべて削除された
        else for (let i = 1; i < updated.length; i++) content.retain(cid); // 保持する内容への参照は、オブジェクトごとに 1 つ
        console.log(`[stage_file] ${cid} (${formatBytes(size)}) now stored; ${updated.length} object(s); blocks from: ${describeSenders(senders, owner)}`);
      } catch (err) {
        console.warn(`[stage_file] failed for ${cid}:`, err instanceof Error ? err.message : err);
        failAll(err instanceof ContentRejected ? err.message : "取得できませんでした");
      } finally {
        staging.delete(cid);
      }
    },
  });
}

/** 取得元の内訳をログ用の文字列にする (置いた人のブラウザは "owner" と表す)。 */
function describeSenders(senders: Map<string, number>, ownerId: string): string {
  if (senders.size === 0) return "(none)";
  const ownerPeer = room.ipfsPeerIdOf(ownerId);
  return [...senders]
    .map(([peer, blocks]) => `${peer === ownerPeer ? "owner" : peer.slice(-8)}=${blocks}`)
    .join(", ");
}

/**
 * crdt-v1 の背景取得。置いた人 (owner) から取得して pin し、文書の stored / size / category を更新する。
 * 失敗してもオブジェクトは削除せず、offline にして所有者に知らせる。同じ CID の取得は 1 回だけ。
 */
function stageFileCrdt(requesterId: string | null, object: FileObject): void {
  if (!store) return;
  const { cid } = object;
  if (object.stored) return;
  if (object.offline || !object.owner) {
    if (requesterId) room.sendPrepareFailed(requesterId, cid, "アップロードした人が退室しているため、取得できません");
    return;
  }
  const waiting = crdtStaging.get(cid);
  if (waiting) {
    if (requesterId) waiting.add(requesterId);
    return;
  }
  const owner = object.owner;
  const waiters = new Set<string>(requesterId ? [requesterId] : []);
  crdtStaging.set(cid, waiters);
  const current = () => store!.fileObjects().filter((file) => file.cid === cid && !file.stored);
  const failAll = (message: string) => {
    for (const file of current()) {
      store!.world.setMetadata(file.id, { offline: true, owner: undefined });
    }
    for (const id of waiters) room.sendPrepareFailed(id, cid, message);
    room.sendError(owner, `${object.name}: ${message}`);
    crdtStaging.delete(cid);
  };
  const progressTo = (loaded: number, total?: number, queued?: boolean) => {
    room.sendPlaceProgress(owner, cid, loaded, total, queued);
    for (const id of waiters) if (id !== owner) room.sendPrepareProgress(id, cid, loaded, total, queued);
  };

  schedule({
    peerKey: owner,
    notifyQueued: () => progressTo(0, undefined, true),
    onFull: () => failAll("順番待ちが多すぎます。しばらくしてからやり直してください"),
    onCancel: () => failAll("アップロードした人が退室したため、取得できません"),
    run: async () => {
      try {
        const fetched = await content.add(cid, "file", {
          onProgress: throttled((loaded, declared) => progressTo(loaded, declared)),
        });
        // 台帳に残ってから stored にする (失敗したら offline のまま)
        try {
          await contentLedger.flush();
        } catch {
          throw new ContentRejected("コンテンツ台帳を保存できませんでした");
        }
        let updated = 0;
        for (const file of current()) {
          store!.world.setMetadata(file.id, {
            stored: true,
            size: fetched.size,
            category: classifyFile(file.name, fetched.head),
            owner: undefined,
            offline: false,
          });
          updated++;
        }
        console.log(`[stage_file] ${cid} (${formatBytes(fetched.size)}) now stored in crdt mode; ${updated} object(s)`);
      } catch (err) {
        console.warn(`[stage_file] failed for ${cid}:`, err instanceof Error ? err.message : err);
        failAll(err instanceof ContentRejected ? err.message : "取得できませんでした");
      } finally {
        crdtStaging.delete(cid);
      }
    },
  });
}

/** サーバーが中身を保持しているオブジェクトか (保持していれば、削除・複製で参照を数える)。 */
const holdsContent = (object: WorldObject): boolean => object.kind === "image" || (object.kind === "file" && object.stored);

wss.on("connection", (ws) => {
  let peerId: string | null = null;
  let closed = false;
  /** この接続が pin しているアバターの CID (通常は 1 つ) */
  const avatarCids = new Map<string, string>();
  /** set_avatar を 1 件ずつ順に処理する (取得中の別の要求で、pin の対応が崩れないように) */
  let avatarUpdates: Promise<void> = Promise.resolve();
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));

  function releaseAvatar(id: string, cid: string): void {
    const size = content.known(cid)?.size;
    content.release(cid);
    console.log(`[avatar] released ${cid} (${size === undefined ? "unknown" : formatBytes(size)}) for ${id}`);
  }

  async function setAvatar(id: string, cid: string | null): Promise<void> {
    if (closed) return;
    const previous = avatarCids.get(id);
    if (cid === previous) return; // 同じアバターの再指定 (null も含む)
    if (cid === null) {
      if (previous) {
        avatarCids.delete(id);
        releaseAvatar(id, previous);
      }
      room.setAvatar(id, null);
      return;
    }
    try {
      // アップロードした人から取得して pin する (既に保持していれば参照だけ増える)
      const { size } = await content.add(cid, "avatar");
      if (closed) {
        content.release(cid); // 取得中に退室したので、この参照は使わない
        return;
      }
      const current = avatarCids.get(id);
      if (current) {
        avatarCids.delete(id);
        releaseAvatar(id, current);
      }
      avatarCids.set(id, cid);
      room.setAvatar(id, cid);
      console.log(`[avatar] ${cid} pinned for ${id} (${formatBytes(size)})`);
    } catch (err) {
      if (closed) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[avatar] failed to fetch ${cid} for ${id}: ${message}`);
      room.sendError(id, `アバターを取得できませんでした: ${message}`);
    }
  }

  ws.on("message", (data, isBinary) => {
    try {
      if (isBinary) return;
      const text = data.toString();
      const msg = parseClientMessage(text);
      if (!msg) {
        // crdt の同期メッセージが不正なら、黙って捨てずに診断できるエラーを返す
        hub?.reportMalformed(ws, text);
        return;
      }
      if (hub?.handleMessage(ws, msg)) return;

    if (msg.type === "join") {
      if (peerId) return; // 二重 join は無視
      peerId = room.join(ws, msg.name).id;
      hub?.attach(ws, peerId);
      console.log(`[join] ${peerId} (room size: ${room.size})`);
    } else if (msg.type === "pose") {
      if (!peerId) return; // join 前は無視
      room.setPose(peerId, msg.pose);
    } else if (msg.type === "ipfs_peer") {
      if (!peerId) return;
      room.announceIpfs(peerId, msg.peerId);
    } else if (msg.type === "set_avatar") {
      if (!peerId) return;
      const id = peerId;
      const cid = msg.cid;
      avatarUpdates = avatarUpdates
        .then(() => setAvatar(id, cid))
        .catch((err: unknown) => console.warn("[avatar] unexpected error:", err instanceof Error ? err.message : err));
    } else if (msg.type === "video_control") {
      if (!peerId) return;
      if (hub) hub.rejectVideo(ws); // crdt-v1 では動画同期は未対応
      else room.setVideoState(msg.id, msg.playing, msg.time);
    } else if (msg.type === "grab_object") {
      if (!peerId) return;
      if (hub) {
        hub.requireReady(ws); // hello 前は sync_error。その後はクライアントが文書を直接更新するので無視
      } else {
        room.grabObject(peerId, msg.id);
      }
    } else if (msg.type === "move_object") {
      if (!peerId) return;
      if (hub) {
        hub.requireReady(ws);
      } else {
        room.moveObject(peerId, msg.id, msg.position, msg.yaw, msg.pitch, msg.scale);
      }
    } else if (msg.type === "release_object") {
      if (!peerId) return;
      if (hub) {
        hub.requireReady(ws);
      } else {
        room.releaseObject(peerId, msg.id);
      }
    } else if (msg.type === "delete_object") {
      if (!peerId) return;
      if (hub) {
        hub.requireReady(ws); // crdt では削除は監視された文書更新で行う。コンテンツも解放しない
      } else {
        const removed = room.deleteObject(peerId, msg.id);
        if (removed && holdsContent(removed) && (removed.kind === "image" || removed.kind === "file")) content.release(removed.cid); // 最後の参照なら、unpin してディスクを空ける
      }
    } else if (msg.type === "duplicate_object") {
      if (!peerId) return;
      if (hub) {
        hub.requireReady(ws); // crdt ではクライアントが新しい ID で複製する。参照は増やさない (pin したまま)
      } else {
        const copy = room.duplicateObject(peerId, msg.id);
        if (copy && holdsContent(copy) && (copy.kind === "image" || copy.kind === "file")) content.retain(copy.cid); // 複製は同じ中身を指す
        if (copy) console.log(`[duplicate] ${msg.id} (${copy.kind}) by ${peerId}`);
      }
    } else if (msg.type === "place_image") {
      if (!peerId) return;
      const { type: _type, ...place } = msg;
      placeImage(peerId, place);
    } else if (msg.type === "place_url") {
      if (peerId) placeFromUrl(peerId, msg.url, msg.position, msg.yaw, msg.objectId);
    } else if (msg.type === "place_box") {
      if (!peerId) return;
      if (store && hub) {
        if (!hub.requireReady(ws)) return;
        if (store.world.count() >= MAX_OBJECTS) {
          room.sendError(peerId, "これ以上オブジェクトを置けません");
          return;
        }
        const object: WorldObject = {
          id: msg.objectId ?? randomUUID(),
          kind: "box",
          position: msg.position,
          yaw: msg.yaw,
          ...(msg.pitch === undefined ? {} : { pitch: msg.pitch }),
          size: msg.size,
          color: msg.color,
        };
        if (insertCrdtObject(object) === "conflict") {
          room.sendError(peerId, "box の objectId が既存のオブジェクトと競合しています");
        }
      } else {
        const { type: _boxtype, ...box } = msg;
        if (room.isFull) {
          room.sendError(peerId, "これ以上オブジェクトを置けません");
        } else if (!room.addBox(box)) {
          room.sendError(peerId, "これ以上オブジェクトを置けません");
        }
      }
    } else if (msg.type === "place_file") {
      if (!peerId) return;
      const { type: _type, ...place } = msg;
      placeFile(peerId, place);
    } else if (msg.type === "request_file") {
      if (!peerId) return;
      if (store) {
        const object = store.world.getObject(msg.id);
        if (object?.kind === "file") stageFileCrdt(peerId, object);
      } else {
        const object = room.getObject(msg.id);
        if (object?.kind === "file") stageFile(peerId, object);
      }
    }
    } catch (err) {
      // 不正なメッセージでプロセスを落とさない
      console.warn("[ws] message handling failed:", err instanceof Error ? err.message : err);
    }
  });

  ws.on("close", () => {
    closed = true;
    if (!peerId) return;
    room.leave(peerId);
    placements.cancelPending(peerId); // 順番待ちのものは、取りに行かない (取得できない)
    if (store) {
      hub?.detach(ws);
      // 配っていたファイルは取得できなくなる。オブジェクトは削除せず、offline にする (文書更新として配る)。
      // ただし背景取得 (crdtStaging) 中の CID は、まだ成功する可能性があるので触らない
      store.markPeerFilesOffline(peerId, crdtStaging);
    }
    for (const [id, cid] of avatarCids) releaseAvatar(id, cid);
    avatarCids.clear();
    console.log(`[leave] ${peerId} (room size: ${room.size})`);
  });

  ws.on("error", (err) => {
    // maxPayload 超過などは ws が close する
    console.warn("[ws error]", err.message);
  });
});

// 応答のない接続を切断する
const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, PING_INTERVAL_MS);

httpServer.on("listening", () => {
  console.log(`Mode: ${SYNC_MODE}${store ? ` (worldId ${store.worldId}, data ${CRDT_DIR})` : ""}`);
  console.log(turn ? `TURN: ${turn.host}:${turn.port} (credentials valid ${turn.ttlSeconds}s)` : "TURN: disabled");
  console.log(`WebSocket server listening on ${HOST}:${PORT}`);
  console.log(`IPFS (libp2p ws) listening on ${HOST}:${IPFS_PORT} (public port ${IPFS_PUBLIC_PORT}) as ${ipfs.info.peerId}`);
  console.log(`Content: ${BLOCKSTORE_DIR} (limit ${MAX_TOTAL_MB} MB in total)`);
});

let shuttingDown = false;
/** 終了処理が固まらないよう、各ステップに設ける上限。 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function withTimeout<T>(task: Promise<T>, label: string, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(pingTimer);
  hub?.close();
  room.close();
  wss.close();
  httpServer.close();
  const warn = (message: string, err?: unknown) =>
    console.warn(`[shutdown] ${message}:`, err instanceof Error ? err.message : err);
  try {
    if (store) {
      try {
        await withTimeout(store.flush(), "world store flush");
      } catch (err) {
        warn("ワールドの保存に失敗しました", err);
      }
      try {
        await withTimeout(contentLedger.flush(), "content ledger flush");
      } catch (err) {
        warn("コンテンツ台帳の保存に失敗しました", err);
      }
      store.close();
    }
    // legacy / crdt のどちらでも、IPFS の停止が失敗・固まっても終了する
    try {
      await withTimeout(ipfs.stop(), "IPFS stop");
    } catch (err) {
      warn("IPFS の停止に失敗しました", err);
    }
  } catch (err) {
    warn("終了処理に失敗しました", err);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
