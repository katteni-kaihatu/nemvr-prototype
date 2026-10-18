import { create } from "zustand";
import {
  IMAGE_UPLOAD_PATH,
  type ClientMessage,
  type PeerInfo,
  type PlaceImage,
  type Pose,
  type ServerMessage,
  type WorldObject,
} from "@proto/protocol";
import { PoseBuffer } from "./interpolation";

/** 補間のために描画を遅らせる時間 (2 tick 分)。 */
export const INTERPOLATION_DELAY_MS = 100;

const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8080`;

/** 画像のアップロード・取得に使う HTTP のベース URL (WebSocket と同じホスト・ポート)。 */
const HTTP_BASE = WS_URL.replace(/^ws/, "http");

export function imageUrl(imageId: string): string {
  return `${HTTP_BASE}${IMAGE_UPLOAD_PATH}/${imageId}`;
}

interface NetState {
  status: "idle" | "connecting" | "connected";
  message: string | null; // 入室画面に表示するエラー等
  self: PeerInfo | null;
  /** 他ユーザーの「集合」のみ React state にする。姿勢は peerBuffers 側。 */
  peers: Record<string, PeerInfo>;
  /** ワールドに置かれたオブジェクト (追加時のみ変化する)。 */
  objects: Record<string, WorldObject>;
  /** 入室中に HUD へ一時表示するメッセージ。 */
  notice: string | null;
}

export const useNet = create<NetState>(() => ({
  status: "idle",
  message: null,
  self: null,
  peers: {},
  objects: {},
  notice: null,
}));

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function showNotice(text: string): void {
  clearTimeout(noticeTimer);
  useNet.setState({ notice: text });
  noticeTimer = setTimeout(() => useNet.setState({ notice: null }), 5000);
}

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

export function sendPlaceImage(place: PlaceImage): void {
  send({ type: "place_image", ...place });
}

/** 画像をサーバーへアップロードして imageId を返す。失敗時は理由付きで throw する。 */
export async function uploadImage(file: Blob): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${HTTP_BASE}${IMAGE_UPLOAD_PATH}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
  } catch {
    throw new Error("画像のアップロードに失敗しました (サーバーに接続できません)");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `画像のアップロードに失敗しました (${res.status})`);
  }
  const { id } = (await res.json()) as { id: string };
  return id;
}

function reset(): void {
  peerBuffers.clear();
  serverTimeOffset = null;
  socket = null;
}

export function connect(name: string): void {
  if (socket) return;
  useNet.setState({
    status: "connecting",
    message: null,
    self: null,
    peers: {},
    objects: {},
    notice: null,
  });

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
        const objects: Record<string, WorldObject> = {};
        for (const o of msg.objects) objects[o.id] = o;
        useNet.setState({ status: "connected", self: msg.self, peers, objects });
        break;
      }
      case "object_added": {
        const { object } = msg;
        useNet.setState((s) => ({ objects: { ...s.objects, [object.id]: object } }));
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
        // 入室後のエラーは HUD に一時表示、入室前は入室画面に表示する
        if (useNet.getState().status === "connected") showNotice(msg.message);
        else useNet.setState({ message: msg.message });
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
      objects: {},
      notice: null,
      message:
        prev.message ??
        (welcomed ? "サーバーとの接続が切断されました" : "サーバーに接続できませんでした"),
    });
  };
}

export function disconnect(): void {
  socket?.close();
}
