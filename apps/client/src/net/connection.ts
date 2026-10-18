import { create } from "zustand";
import {
  formatBytes,
  type ClientMessage,
  type FileObject,
  type PeerInfo,
  type PlaceFile,
  type PlaceImage,
  type Pose,
  type ServerMessage,
  type WorldObject,
} from "@proto/protocol";
import { resetInteraction, useInteraction } from "../world/interaction";
import { needsLocalFile } from "./lazyUploads";
import { PoseBuffer } from "./interpolation";
import {
  describeError,
  dialPeer,
  holdUpload,
  IpfsUnavailableError,
  keepServing,
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

// ---- 大きなファイルの遅延転送: ダウンロードのために、サーバーに取得させて待つ ----

interface PrepareWait {
  object: FileObject;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** サーバーが保持するのを待っているダウンロード (オブジェクト ID → 待ち)。 */
const prepareWaits = new Map<string, PrepareWait>();
/** サーバーから、進捗も完了も失敗も届かない状態がこの時間続いたら、諦める。 */
const PREPARE_IDLE_MS = 60_000;

function settlePrepare(id: string, error?: Error): void {
  const wait = prepareWaits.get(id);
  if (!wait) return;
  clearTimeout(wait.timer);
  prepareWaits.delete(id);
  if (error) wait.reject(error);
  else wait.resolve();
}

function armPrepareTimer(wait: PrepareWait): void {
  clearTimeout(wait.timer);
  wait.timer = setTimeout(() => settlePrepare(wait.object.id, new Error("サーバーから応答がありません")), PREPARE_IDLE_MS);
}

/**
 * まだサーバーが保持していないファイル (大きなファイル) を、サーバーに取得させて、保持されるまで待つ。
 * ダウンロードされたときに初めて、サーバーが置いた人から取得する。進捗は HUD に表示される。
 * 失敗 (置いた人が退室した・容量が足りない・削除された・応答がない) は例外で知らせる。
 */
export function requestStored(object: FileObject): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wait: PrepareWait = { object, resolve, reject, timer: undefined as never };
    armPrepareTimer(wait);
    prepareWaits.set(object.id, wait);
    send({ type: "request_file", id: object.id });
  });
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
  for (const id of [...prepareWaits.keys()]) settlePrepare(id, new Error("サーバーとの接続が切れました"));
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
        if (object.kind === "file") {
          // ダウンロードのために待っていたファイルを、サーバーが保持した (または、取得できなくなった)
          if (object.stored) settlePrepare(object.id);
          else if (object.offline) settlePrepare(object.id, new Error("アップロードした人が退室しているため、取得できません"));
          // サーバーが保持したので、自分が配り続ける必要はなくなった
          if (!needsLocalFile(useNet.getState().objects, object.cid, useNet.getState().self?.id)) releaseUpload(object.cid);
        }
        // 自分がつかもうとしたが、先に他の人がつかんでいた (サーバーに拒否された)
        const interaction = useInteraction.getState();
        const selfId = useNet.getState().self?.id;
        if (interaction.grabbedId === object.id && object.heldBy && object.heldBy !== selfId) {
          useInteraction.setState({ grabbedId: null });
        }
        break;
      }
      case "object_removed": {
        const removed = useNet.getState().objects[msg.id];
        useNet.setState((s) => {
          const { [msg.id]: _removed, ...rest } = s.objects;
          return { objects: rest };
        });
        settlePrepare(msg.id, new Error("削除されました"));
        // 自分が配っていたファイルが、すべて削除された
        if (removed?.kind === "file" && !needsLocalFile(useNet.getState().objects, removed.cid, useNet.getState().self?.id)) {
          releaseUpload(removed.cid);
        }
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
        const name = pendingUploads.get(object.cid);
        pendingUploads.delete(object.cid);
        if (object.kind === "file" && !object.stored && object.owner === useNet.getState().self?.id) {
          // 大きなファイル: サーバーは、ダウンロードされるまで取得しない。それまで、このタブが配り続ける
          keepServing(object.cid);
          showNotice(
            `${name ?? object.name}: 置きました。ダウンロードされるまでデータは送りません (このタブを開いたままにしてください)`,
            12_000,
          );
        } else {
          // 自分が置いたものをサーバーが取り終えた。ブラウザ側のブロックは、もう配らなくてよい
          releaseUpload(object.cid);
        }
        break;
      }
      case "prepare_progress": {
        // ダウンロードのために、サーバーが、置いた人からファイルを取得している途中 (または順番待ち)
        for (const wait of prepareWaits.values()) if (wait.object.cid === msg.cid) armPrepareTimer(wait);
        const name = [...prepareWaits.values()].find((w) => w.object.cid === msg.cid)?.object.name ?? "ファイル";
        if (msg.queued) {
          showNotice(`${name}: ダウンロードの準備 (順番待ち)`, 15_000);
          break;
        }
        const amount = msg.total
          ? `${Math.min(100, Math.floor((msg.loaded / msg.total) * 100))}% (${formatBytes(msg.loaded)} / ${formatBytes(msg.total)})`
          : formatBytes(msg.loaded);
        showNotice(`${name}: ダウンロードの準備中 (サーバーが、置いた人から取得しています) ${amount}`, 8000);
        break;
      }
      case "prepare_failed": {
        for (const wait of [...prepareWaits.values()]) {
          if (wait.object.cid === msg.cid) settlePrepare(wait.object.id, new Error(msg.message));
        }
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
