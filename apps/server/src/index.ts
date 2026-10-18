import { WebSocketServer, type WebSocket } from "ws";
import { MAX_MESSAGE_BYTES } from "@proto/protocol";
import { ImageRejected, startIpfs } from "./ipfs.js";
import { Room } from "./room.js";
import { parseClientMessage } from "./validate.js";

const PORT = Number(process.env.PORT ?? 8080);
const IPFS_PORT = Number(process.env.IPFS_PORT ?? 8081);
const PING_INTERVAL_MS = 30_000;
const MAX_CONCURRENT_VERIFY = 4; // 同時に検証 (IPFS から取得) する画像の数

const ipfs = await startIpfs(IPFS_PORT);
const room = new Room(ipfs.info);
const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_BYTES });
const alive = new WeakSet<WebSocket>();
let verifying = 0;

/** 画像の中身を IPFS から取得・検証して pin し、通ったらワールドに置く。 */
function placeImage(peerId: string, place: Parameters<Room["addImage"]>[0]): void {
  if (room.isFull) {
    room.sendError(peerId, "これ以上オブジェクトを置けません");
    return;
  }
  if (verifying >= MAX_CONCURRENT_VERIFY) {
    room.sendError(peerId, "処理中の画像が多すぎます。少し待ってからやり直してください");
    return;
  }
  verifying++;
  ipfs
    .fetchAndPin(place.cid)
    .then(() => {
      if (room.addImage(place)) console.log(`[place_image] ${place.cid} by ${peerId}`);
      else room.sendError(peerId, "これ以上オブジェクトを置けません");
    })
    .catch((err: unknown) => {
      if (!(err instanceof ImageRejected)) console.warn("[place_image] unexpected error:", err);
      room.sendError(peerId, err instanceof ImageRejected ? err.message : "画像を置けませんでした");
    })
    .finally(() => {
      verifying--;
    });
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
    } else if (msg.type === "place_image") {
      if (!peerId) return;
      const { type: _type, ...place } = msg;
      placeImage(peerId, place);
    }
  });

  ws.on("close", () => {
    if (!peerId) return;
    room.leave(peerId);
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
  console.log(`WebSocket server listening on :${PORT}`);
  console.log(`IPFS (libp2p ws) listening on :${IPFS_PORT} as ${ipfs.info.peerId}`);
});

function shutdown(): void {
  clearInterval(pingTimer);
  room.close();
  wss.close();
  void ipfs.stop().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
