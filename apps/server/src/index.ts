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
const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_MESSAGE_BYTES });
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
 * ファイル: 小さければ (EAGER_FILE_MAX_BYTES 以下) 置いた時点で全部取得して保持する (置いた人が退室しても使える)。
 * 大きければ、ダウンロードされるまで取得しない (遅延転送)。宣言されたサイズと、先頭の数バイト (アイコンの種類の判定用)
 * だけを調べて、置いた人が配り続ける前提でワールドに置く。中身は保持せず、容量も使わない。
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
          if (room.addFile({ ...place, size: probe.size, category, stored: false, owner: peerId })) {
            console.log(`[place_file] ${cid} (${formatBytes(probe.size)}, lazy: not transferred until downloaded) by ${peerId}`);
          } else {
            room.sendError(peerId, "これ以上オブジェクトを置けません");
          }
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

/** ダウンロードのために、まだ保持していないファイルを要求した人 (CID ごと)。同じ内容は 1 回だけ取得して、みんなで待つ。 */
const staging = new Map<string, Set<string>>();

/**
 * まだ保持していない (遅延転送の) ファイルを、置いた人から取得して保持する。ダウンロードされたときに呼ばれる。
 * 終わると `object_updated` (stored) が全員に配られるので、要求した人はそれを見て進む。
 * 同じ内容を複数人が要求したら、取得は 1 回で、進捗・失敗はみんなに知らせる。
 */
function stageFile(requesterId: string, object: FileObject): void {
  const { cid } = object;
  console.log(`[request_file] ${cid} by ${requesterId} (stored: ${object.stored}, offline: ${!!object.offline}, owner: ${object.owner ?? "-"})`);
  if (object.stored) return; // もう保持している。要求した人は、object_updated で進む
  if (object.offline || !object.owner) {
    room.sendPrepareFailed(requesterId, cid, "アップロードした人が退室しているため、取得できません");
    return;
  }
  const waiting = staging.get(cid);
  if (waiting) {
    waiting.add(requesterId); // 取得中。一緒に待つ
    return;
  }
  const waiters = new Set([requesterId]);
  staging.set(cid, waiters);
  const failAll = (message: string) => {
    for (const id of waiters) room.sendPrepareFailed(id, cid, message);
    staging.delete(cid);
  };
  const toAll = (send: (id: string) => void) => waiters.forEach(send);

  schedule({
    peerKey: object.owner, // 取りに行く相手 (置いた人) の接続ごとに、1 件ずつ
    notifyQueued: () => toAll((id) => room.sendPrepareProgress(id, cid, 0, undefined, true)),
    onFull: () => failAll("順番待ちが多すぎます。しばらくしてからやり直してください"),
    onCancel: () => failAll("アップロードした人が退室したため、取得できません"),
    run: async () => {
      try {
        const { size } = await content.add(cid, "file", {
          onProgress: throttled((loaded, declared) => toAll((id) => room.sendPrepareProgress(id, cid, loaded, declared))),
        });
        const updated = room.markStored(cid, size);
        if (updated.length === 0) content.release(cid); // 取得している間に、すべて削除された
        else for (let i = 1; i < updated.length; i++) content.retain(cid); // 保持する内容への参照は、オブジェクトごとに 1 つ
        console.log(`[stage_file] ${cid} (${formatBytes(size)}) now stored; ${updated.length} object(s)`);
      } catch (err) {
        console.warn(`[stage_file] failed for ${cid}:`, err instanceof Error ? err.message : err);
        failAll(err instanceof ContentRejected ? err.message : "取得できませんでした");
      } finally {
        staging.delete(cid);
      }
    },
  });
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

wss.on("listening", () => {
  console.log(turn ? `TURN: ${turn.host}:${turn.port} (credentials valid ${turn.ttlSeconds}s)` : "TURN: disabled");
  console.log(`WebSocket server listening on ${HOST}:${PORT}`);
  console.log(`IPFS (libp2p ws) listening on ${HOST}:${IPFS_PORT} (public port ${IPFS_PUBLIC_PORT}) as ${ipfs.info.peerId}`);
  console.log(`Content: ${BLOCKSTORE_DIR} (limit ${MAX_TOTAL_MB} MB in total)`);
});

function shutdown(): void {
  clearInterval(pingTimer);
  room.close();
  wss.close();
  void ipfs.stop().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
