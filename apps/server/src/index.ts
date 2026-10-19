import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  EAGER_FILE_MAX_BYTES,
  MAX_MESSAGE_BYTES,
  classifyFile,
  formatBytes,
  type FileObject,
  type PlaceFile,
  type PlaceImage,
  type WorldObject,
} from "@proto/protocol";
import { ContentStore } from "./content.js";
import { ContentRejected, startIpfs } from "./ipfs.js";
import { mediaType, parseRange } from "./media.js";
import { PlacementQueue } from "./queue.js";
import { Room } from "./room.js";
import { iceServersFor, turnConfigFromEnv } from "./turn.js";
import { parseClientMessage } from "./validate.js";

const PORT = Number(process.env.PORT ?? 8080);
const IPFS_PORT = Number(process.env.IPFS_PORT ?? 8081);
// リバースプロキシ (TLS 終端) の背後で動かすときは HOST=127.0.0.1、
// ブラウザから見た libp2p のポートが IPFS_PORT と違う場合は IPFS_PUBLIC_PORT で指定する
const HOST = process.env.HOST ?? "0.0.0.0";
const IPFS_PUBLIC_PORT = Number(process.env.IPFS_PUBLIC_PORT ?? IPFS_PORT);
const PING_INTERVAL_MS = 30_000;
// 画像・ファイルの取り込み (IPFS から取得) の順番待ち。同じ人の分は 1 件ずつ (同じ接続の転送は先着順に処理されるので、
// 並列にすると後ろが飢えてタイムアウトする)、全体では同時にこの件数まで
const MAX_CONCURRENT_VERIFY = 4;
const MAX_PENDING_PER_PEER = 16; // 1 人が順番待ちにできる件数
const QUEUED_HEARTBEAT_MS = 10_000; // 順番待ちの間、本人に状況を知らせる間隔 (クライアントが、配るのをやめないように)
// サーバーが保持する画像・ファイルの合計サイズの上限 (MB)。ディスクに置くので、ディスクの空きより十分小さくする。
// 既定は 20 GiB (2 GiB のファイルを 10 個まで)
const MAX_TOTAL_MB = Number(process.env.CONTENT_MAX_TOTAL_MB ?? 20 * 1024);
// 画像・ファイルの中身 (ブロック) を置くディレクトリ。起動のたびに空にする (再起動でワールドの状態が消えるので、残しても参照されない)
const BLOCKSTORE_DIR = process.env.BLOCKSTORE_DIR ?? join(tmpdir(), "vr-sns-proto-blocks");
const PROGRESS_INTERVAL_MS = 500; // 取得の進捗を、置いている本人に知らせる間隔

const ipfs = await startIpfs(IPFS_PORT, { host: HOST, publicPort: IPFS_PUBLIC_PORT, blockstoreDir: BLOCKSTORE_DIR });
// TURN (WebRTC の中継)。TURN_HOST と TURN_SECRET が未設定なら使わない (クライアントは既定の公開 STUN のみ)
const turn = turnConfigFromEnv(process.env);
const room = new Room(ipfs.info, (userId) => iceServersFor(turn, userId));
room.seedDemoBoxes(); // デモ空間のボックス (つかんで動かせる)
// 置かれた画像・ファイルの中身 (CID) の保持。参照が無くなったら unpin + gc で解放する
const content = new ContentStore(ipfs, {
  maxTotalBytes: MAX_TOTAL_MB * 1024 * 1024,
  log: (message) => console.log(`[content] ${message}`),
});
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
  const object = room.findStoredFile(cid);
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
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
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

/**
 * ファイル: 置いた時点で、サーバーが取得して保持する (置いた人が、いつ退室するか分からないため)。
 * 小さければ (EAGER_FILE_MAX_BYTES 以下)、全部取得してから置く。
 * 大きければ、宣言サイズと先頭の数バイト (アイコンの種類の判定用) だけを調べて、すぐに置き (`stored: false`)、
 * 続けて、サーバーが全部をバックグラウンドで取得する (stageFile)。取り終えるまで、置いた人のブラウザが配り続ける。
 * ダウンロードする人は、先に直接取得を試し、だめなら `request_file` でこの取得の完了を待つ。
 */
function placeFile(peerId: string, place: PlaceFile): void {
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

/** サーバーが中身を保持しているオブジェクトか (保持していれば、削除・複製で参照を数える)。 */
const holdsContent = (object: WorldObject): boolean => object.kind === "image" || (object.kind === "file" && object.stored);

wss.on("connection", (ws) => {
  let peerId: string | null = null;
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = parseClientMessage(data.toString());
    if (!msg) return; // 不正なメッセージは無視

    if (msg.type === "join") {
      if (peerId) return; // 二重 join は無視
      peerId = room.join(ws, msg.name).id;
      console.log(`[join] ${peerId} (room size: ${room.size})`);
    } else if (msg.type === "pose") {
      if (!peerId) return; // join 前は無視
      room.setPose(peerId, msg.pose);
    } else if (msg.type === "ipfs_peer") {
      if (!peerId) return;
      room.announceIpfs(peerId, msg.peerId);
    } else if (msg.type === "grab_object") {
      if (peerId) room.grabObject(peerId, msg.id);
    } else if (msg.type === "move_object") {
      if (peerId) room.moveObject(peerId, msg.id, msg.position, msg.yaw, msg.pitch);
    } else if (msg.type === "release_object") {
      if (peerId) room.releaseObject(peerId, msg.id);
    } else if (msg.type === "delete_object") {
      if (!peerId) return;
      const removed = room.deleteObject(peerId, msg.id);
      if (removed && holdsContent(removed) && (removed.kind === "image" || removed.kind === "file")) content.release(removed.cid); // 最後の参照なら、unpin してディスクを空ける
    } else if (msg.type === "duplicate_object") {
      if (!peerId) return;
      const copy = room.duplicateObject(peerId, msg.id);
      if (copy && holdsContent(copy) && (copy.kind === "image" || copy.kind === "file")) content.retain(copy.cid); // 複製は同じ中身を指す
    } else if (msg.type === "place_image") {
      if (!peerId) return;
      const { type: _type, ...place } = msg;
      placeImage(peerId, place);
    } else if (msg.type === "place_box") {
      if (!peerId) return;
      const { type: _boxtype, ...box } = msg;
      if (room.isFull) {
        room.sendError(peerId, "これ以上オブジェクトを置けません");
      } else if (!room.addBox(box)) {
        room.sendError(peerId, "これ以上オブジェクトを置けません");
      }
    } else if (msg.type === "place_file") {
      if (!peerId) return;
      const { type: _type, ...place } = msg;
      placeFile(peerId, place);
    } else if (msg.type === "request_file") {
      if (!peerId) return;
      const object = room.getObject(msg.id);
      if (object?.kind === "file") stageFile(peerId, object);
    }
  });

  ws.on("close", () => {
    if (!peerId) return;
    room.leave(peerId);
    placements.cancelPending(peerId); // 順番待ちのものは、取りに行かない (取得できない)
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
  console.log(turn ? `TURN: ${turn.host}:${turn.port} (credentials valid ${turn.ttlSeconds}s)` : "TURN: disabled");
  console.log(`WebSocket server listening on ${HOST}:${PORT}`);
  console.log(`IPFS (libp2p ws) listening on ${HOST}:${IPFS_PORT} (public port ${IPFS_PUBLIC_PORT}) as ${ipfs.info.peerId}`);
  console.log(`Content: ${BLOCKSTORE_DIR} (limit ${MAX_TOTAL_MB} MB in total)`);
});

function shutdown(): void {
  clearInterval(pingTimer);
  room.close();
  wss.close();
  httpServer.close();
  void ipfs.stop().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
