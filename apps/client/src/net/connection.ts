import { create } from "zustand";
import {
  formatBytes,
  type ClientMessage,
  type PeerInfo,
  type PlaceFile,
  type PlaceImage,
  type Pose,
  type ServerMessage,
  type WorldObject,
} from "@proto/protocol";
import { resetInteraction, useInteraction } from "../world/interaction";
import { PoseBuffer } from "./interpolation";
import {
  describeError,
  dialPeer,
  holdUpload,
  IpfsUnavailableError,
  releaseUpload,
  startIpfs,
  stopIpfs,
  waitForDialable,
} from "./ipfs";

/** 補間のために描画を遅らせる時間 (2 tick 分)。 */
export const INTERPOLATION_DELAY_MS = 100;

const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  (location.protocol === "https:"
    ? `wss://${location.host}/ws` // HTTPS 配信時は、リバースプロキシが /ws をサーバーへ転送する前提
    : `ws://${location.hostname}:8080`);

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
  /** ブラウザ内 IPFS ノードの状態。 */
  ipfs: "idle" | "starting" | "ready" | "error";
  /** 他のブラウザとの直接 (WebRTC) 接続の数。 */
  directPeers: number;
}

export const useNet = create<NetState>(() => ({
  status: "idle",
  message: null,
  self: null,
  peers: {},
  objects: {},
  notice: null,
  ipfs: "idle",
  directPeers: 0,
}));

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function showNotice(text: string, durationMs = 5000): void {
  clearTimeout(noticeTimer);
  useNet.setState({ notice: text });
  noticeTimer = setTimeout(() => useNet.setState({ notice: null }), durationMs);
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

/** サーバーへ転送中のアップロード (CID → ファイル名)。進捗の通知にファイル名を付けるために覚えておく。 */
const pendingUploads = new Map<string, string>();

/** 置こうとしているファイル (CID とファイル名) を覚える。サーバーからの進捗の通知に使う。 */
export function expectUpload(cid: string, name: string): void {
  pendingUploads.set(cid, name);
}

export function sendPlaceFile(place: PlaceFile): void {
  send({ type: "place_file", ...place });
}

export const sendGrabObject = (id: string): void => send({ type: "grab_object", id });
export const sendReleaseObject = (id: string): void => send({ type: "release_object", id });
export const sendDeleteObject = (id: string): void => send({ type: "delete_object", id });
export const sendDuplicateObject = (id: string): void => send({ type: "duplicate_object", id });
export function sendMoveObject(id: string, position: [number, number, number], yaw: number): void {
  send({ type: "move_object", id, position, yaw });
}

/**
 * 自分が動かしたオブジェクトの位置を、手元の状態にも反映する。
 * 移動中の自分への配信 (echo) は無いので、離したときに古い位置へ戻って見えないようにする。
 */
export function applyLocalObjectPose(id: string, position: [number, number, number], yaw: number): void {
  useNet.setState((s) => {
    const object = s.objects[id];
    return object ? { objects: { ...s.objects, [id]: { ...object, position, yaw } } } : s;
  });
}

function reset(): void {
  pendingUploads.clear();
  resetInteraction();
  void stopIpfs();
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
    ipfs: "idle",
    directPeers: 0,
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
        useNet.setState({ status: "connected", self: msg.self, peers, objects, ipfs: "starting" });
        // 画像の取得・共有に使うブラウザ内 IPFS ノードを起動してサーバーに接続する
        startIpfs(msg.ipfs, msg.iceServers, (directPeers) => useNet.setState({ directPeers })).then(
          () => {
            useNet.setState({ ipfs: "ready" });
            // 他のブラウザから直接接続してもらえる状態になったら、自分のピア ID を知らせる
            waitForDialable().then(
              (peerId) => send({ type: "ipfs_peer", peerId }),
              (err: unknown) => console.warn(`[ipfs] not dialable: ${describeError(err)}`, err),
            );
          },
          (err: unknown) => {
            console.warn(`[ipfs] start failed: ${describeError(err)}`, err);
            useNet.setState({ ipfs: "error" });
            showNotice(
              err instanceof IpfsUnavailableError
                ? err.message
                : "IPFS ノードに接続できません。画像の共有ができません",
              15_000,
            );
          },
        );
        break;
      }
      case "object_updated": {
        const { object } = msg;
        useNet.setState((s) => ({ objects: { ...s.objects, [object.id]: object } }));
        // 自分がつかもうとしたが、先に他の人がつかんでいた (サーバーに拒否された)
        const interaction = useInteraction.getState();
        const selfId = useNet.getState().self?.id;
        if (interaction.grabbedId === object.id && object.heldBy && object.heldBy !== selfId) {
          useInteraction.setState({ grabbedId: null });
        }
        break;
      }
      case "object_removed": {
        useNet.setState((s) => {
          const { [msg.id]: _removed, ...rest } = s.objects;
          return { objects: rest };
        });
        const interaction = useInteraction.getState();
        useInteraction.setState({
          hoverId: interaction.hoverId === msg.id ? null : interaction.hoverId,
          grabbedId: interaction.grabbedId === msg.id ? null : interaction.grabbedId,
          menuTargetId: interaction.menuTargetId === msg.id ? null : interaction.menuTargetId,
        });
        break;
      }
      case "peer_ipfs": {
        // 後から準備ができた人へ、既にいる側から直接接続しに行く
        void dialPeer(msg.ipfsPeerId);
        break;
      }
      case "object_added": {
        const { object } = msg;
        useNet.setState((s) => ({ objects: { ...s.objects, [object.id]: object } }));
        // 自分が置いたものをサーバーが取り終えた。ブラウザ側のブロックは、もう保持しなくてよい
        pendingUploads.delete(object.cid);
        releaseUpload(object.cid);
        break;
      }
      case "place_progress": {
        // サーバーが、置こうとしている中身を取得している途中。大きなファイルは数分かかるので、状況を表示する
        holdUpload(msg.cid); // 動いている間は、ブラウザ側のブロックを消さない
        const name = pendingUploads.get(msg.cid) ?? "ファイル";
        if (msg.queued) {
          // サーバーが、先に送った分の取り込みを終えるまで待っている (同じ人の分は、1 件ずつ順に取り込む)
          showNotice(`${name}: 順番待ち (前の転送が終わるまで待っています)`, 15_000);
          break;
        }
        const amount = msg.total
          ? `${Math.min(100, Math.floor((msg.loaded / msg.total) * 100))}% (${formatBytes(msg.loaded)} / ${formatBytes(msg.total)})`
          : formatBytes(msg.loaded);
        showNotice(`${name}: サーバーへ転送中 ${amount}`, 8000);
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
      ipfs: "idle",
      directPeers: 0,
      message:
        prev.message ??
        (welcomed ? "サーバーとの接続が切断されました" : "サーバーに接続できませんでした"),
    });
  };
}

export function disconnect(): void {
  socket?.close();
}

// 開発時のみ、E2E テストやコンソールから状態を確認できるようにする
if (import.meta.env.DEV) {
  (window as unknown as { __net: unknown }).__net = useNet;
}
