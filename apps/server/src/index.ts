import { WebSocketServer, type WebSocket } from "ws";
import { MAX_MESSAGE_BYTES } from "@proto/protocol";
import { Room } from "./room.js";
import { parseClientMessage } from "./validate.js";

const PORT = Number(process.env.PORT ?? 8080);
const PING_INTERVAL_MS = 30_000;

const room = new Room();
const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_BYTES });
const alive = new WeakSet<WebSocket>();

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

wss.on("listening", () => console.log(`WebSocket server listening on :${PORT}`));

function shutdown(): void {
  clearInterval(pingTimer);
  room.close();
  wss.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
