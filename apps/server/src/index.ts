import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { MAX_MESSAGE_BYTES, classifyFile, formatBytes } from "@proto/protocol";
import { ContentStore, type ContentKind } from "./content.js";
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
// 置かれた画像・ファイルの中身 (CID) の保持。参照が無くなったら unpin + gc で解放する
const content = new ContentStore(ipfs, {
  maxTotalBytes: MAX_TOTAL_MB * 1024 * 1024,
  log: (message) => console.log(`[content] ${message}`),
});
const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_MESSAGE_BYTES });
const alive = new WeakSet<WebSocket>();
const placements = new PlacementQueue(MAX_CONCURRENT_VERIFY, MAX_PENDING_PER_PEER);

/**
 * 画像・ファイルの中身を IPFS から取得・検証して pin し、通ったらワールドに置く。
 * add は、検証済みの内容 (実測のサイズ・先頭バイト) を受け取って、置けたら true を返す。
 */
function placeContent(
  peerId: string,
  kind: ContentKind,
  cid: string,
  add: (fetched: { size: number; head: Uint8Array }) => boolean,
): void {
  const label = kind === "image" ? "画像" : "ファイル";
  if (room.isFull) {
    room.sendError(peerId, "これ以上オブジェクトを置けません");
    return;
  }

  let lastProgressAt = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const run = async (): Promise<void> => {
    try {
      const fetched = await content.add(cid, kind, {
        onProgress: (loaded, declared) => {
          const now = Date.now();
          if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          room.sendPlaceProgress(peerId, cid, loaded, declared);
        },
      });
      if (add(fetched)) {
        console.log(`[place_${kind}] ${cid} (${formatBytes(fetched.size)}) by ${peerId}`);
      } else {
        content.release(cid); // 検証している間に満杯になった
        room.sendError(peerId, "これ以上オブジェクトを置けません");
      }
    } catch (err) {
      if (!(err instanceof ContentRejected)) console.warn(`[place_${kind}] unexpected error:`, err);
      room.sendError(peerId, err instanceof ContentRejected ? err.message : `${label}を置けませんでした`);
    }
  };

  const result = placements.enqueue({
    peerId,
    run,
    onStart: () => clearInterval(heartbeat),
    onCancel: () => clearInterval(heartbeat), // 順番待ちの間に本人が退室した
  });
  if (result === "full") {
    room.sendError(peerId, `順番待ちの${label}が多すぎます。いくつか終わってからやり直してください`);
  } else if (result === "queued") {
    // 前の転送が終わるまで、取得を始めない。待っている間も、本人に知らせ続ける
    // (クライアントは、サーバーの通知が続く間だけ、ファイルを配り続ける)
    room.sendPlaceProgress(peerId, cid, 0, undefined, true);
    heartbeat = setInterval(() => room.sendPlaceProgress(peerId, cid, 0, undefined, true), QUEUED_HEARTBEAT_MS);
  }
}

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
      if (peerId) room.moveObject(peerId, msg.id, msg.position, msg.yaw);
    } else if (msg.type === "release_object") {
      if (peerId) room.releaseObject(peerId, msg.id);
    } else if (msg.type === "delete_object") {
      if (!peerId) return;
      const removed = room.deleteObject(peerId, msg.id);
      if (removed) content.release(removed.cid); // 最後の参照なら、unpin してメモリを空ける
    } else if (msg.type === "duplicate_object") {
      if (!peerId) return;
      const copy = room.duplicateObject(peerId, msg.id);
      if (copy) content.retain(copy.cid); // 複製は同じ中身を指す
    } else if (msg.type === "place_image") {
      if (!peerId) return;
      const { type: _type, ...place } = msg;
      placeContent(peerId, "image", place.cid, () => room.addImage(place));
    } else if (msg.type === "place_file") {
      if (!peerId) return;
      const { type: _type, ...place } = msg;
      placeContent(peerId, "file", place.cid, ({ size, head }) =>
        // 種類 (アイコン) とサイズは、クライアントの申告ではなく、取得した中身から決める
        room.addFile({ ...place, size, category: classifyFile(place.name, head) }),
      );
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
