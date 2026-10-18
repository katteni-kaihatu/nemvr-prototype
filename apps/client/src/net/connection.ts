import { create } from "zustand";
import type { ClientMessage, PeerInfo, Pose, ServerMessage } from "@proto/protocol";
import { PoseBuffer } from "./interpolation";

/** 補間のために描画を遅らせる時間 (2 tick 分)。 */
export const INTERPOLATION_DELAY_MS = 100;

const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8080`;

interface NetState {
  status: "idle" | "connecting" | "connected";
  message: string | null; // 入室画面に表示するエラー等
  self: PeerInfo | null;
  /** 他ユーザーの「集合」のみ React state にする。姿勢は peerBuffers 側。 */
  peers: Record<string, PeerInfo>;
}

export const useNet = create<NetState>(() => ({
  status: "idle",
  message: null,
  self: null,
  peers: {},
}));

/** 毎フレーム参照される姿勢履歴。React state にはしない。 */
export const peerBuffers = new Map<string, PoseBuffer>();

let socket: WebSocket | null = null;
let serverTimeOffset: number | null = null;

/** 現在のサーバー時刻の推定値 (ms)。snapshot 未受信なら null。 */
export function serverNow(): number | null {
  return serverTimeOffset === null ? null : Date.now() + serverTimeOffset;
}

function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export function sendPose(pose: Pose): void {
  send({ type: "pose", pose });
}

function reset(): void {
  peerBuffers.clear();
  serverTimeOffset = null;
  socket = null;
}

export function connect(name: string): void {
  if (socket) return;
  useNet.setState({ status: "connecting", message: null, self: null, peers: {} });

  const ws = new WebSocket(WS_URL);
  socket = ws;
  let welcomed = false;

  ws.onopen = () => send({ type: "join", name });

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    handleMessage(msg);
  };

  const handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "welcome": {
        welcomed = true;
        const peers: Record<string, PeerInfo> = {};
        for (const p of msg.peers) {
          peers[p.id] = { id: p.id, name: p.name, color: p.color };
        }
        useNet.setState({ status: "connected", self: msg.self, peers });
        break;
      }
      case "peer_joined": {
        const { id, name, color } = msg.peer;
        useNet.setState((s) => ({ peers: { ...s.peers, [id]: { id, name, color } } }));
        break;
      }
      case "peer_left": {
        peerBuffers.delete(msg.id);
        useNet.setState((s) => {
          const { [msg.id]: _removed, ...rest } = s.peers;
          return { peers: rest };
        });
        break;
      }
      case "snapshot": {
        // 初回のみオフセットを求める (簡素化のため再補正しない)
        serverTimeOffset ??= msg.time - Date.now();
        const selfId = useNet.getState().self?.id;
        for (const [id, pose] of Object.entries(msg.poses)) {
          if (id === selfId) continue;
          let buf = peerBuffers.get(id);
          if (!buf) peerBuffers.set(id, (buf = new PoseBuffer()));
          buf.push(msg.time, pose);
        }
        break;
      }
      case "error": {
        useNet.setState({ message: msg.message });
        break;
      }
    }
  };

  ws.onclose = () => {
    const prev = useNet.getState();
    reset();
    useNet.setState({
      status: "idle",
      self: null,
      peers: {},
      message:
        prev.message ??
        (welcomed ? "サーバーとの接続が切断されました" : "サーバーに接続できませんでした"),
    });
  };
}

export function disconnect(): void {
  socket?.close();
}
