import { create } from "zustand";
import {
  formatBytes,
  MAX_AVATAR_BYTES,
  type ClientMessage,
  type CrdtSyncInfo,
  type FileObject,
  type PeerInfo,
  type PlaceFile,
  type PlaceImage,
  type Pose,
  type ServerMessage,
  type Vec3,
  type VideoPlaybackState,
  type WorldObject,
} from "@proto/protocol";
import { resetInteraction, useInteraction } from "../world/interaction";
import { needsLocalFile, uploadsToRelease } from "./lazyUploads";
import { PoseBuffer } from "./interpolation";
import { openCrdtWorld, type CrdtCallbacks, type CrdtSyncStatus, type CrdtWorld } from "./crdt";
import {
  forgetSyncPeer,
  p2pPeerCount,
  rememberSyncPeer,
  startWorldSyncP2P,
  stopWorldSyncP2P,
} from "./crdtP2P";
import {
  addContent,
  describeError,
  dialPeer,
  rememberPeerName,
  holdUpload,
  IpfsUnavailableError,
  isServing,
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
  /** 動画の再生状態 (サーバーが保持)。オブジェクト ID ごと。 */
  videoStates: Record<string, VideoPlaybackState>;
  /** 同期モード。crdt-v1 のときだけ legacy 以外になる。 */
  sync: "legacy" | CrdtSyncStatus;
  localSaved: boolean;
  serverSaved: boolean;
  peerCount: number;
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
  videoStates: {},
  sync: "legacy",
  localSaved: false,
  serverSaved: false,
  peerCount: 0,
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

/** クライアントの実験モード指定。既定は legacy。 */
const requested = import.meta.env.VITE_SYNC_MODE === "crdt-v1";

let crdtWorld: CrdtWorld | null = null;
let crdtInfo: CrdtSyncInfo | null = null;
/** 入室したサーバーが crdt-v1 だった (再接続でも維持する)。 */
let crdtMode = false;

/** 実際に使える CRDT ワールドがあるか (module global の crdtActive に依存しない)。 */
export function isCrdtWorldAvailable(): boolean {
  return crdtMode && crdtWorld !== null;
}
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let explicitExit = false;
let lastName = "";
let lastAvatarFile: File | null = null;
let crdtNoticeShown = false;
let connectionEpoch = 0;

/** この入室セッションで P2P 同期相手として覚えた IPFS ピア ID (明示的な退出で忘れる)。 */
const knownSyncPeers = new Set<string>();
/** Helia / libp2p が使える状態か (P2P transport を開始してよいか)。 */
let p2pIpfsReady = false;
let p2pStart: Promise<void> | null = null;

interface PendingPlacement {
  message: ClientMessage;
  cid: string;
  name: string;
}

/** オフライン中に置こうとしたファイル (接続が戻ったら、同じ objectId で送る)。 */
let pendingPlacements: PendingPlacement[] = [];

/** 現在のサーバー時刻の推定値 (ms)。snapshot 未受信なら null。 */
export function serverNow(): number | null {
  return serverTimeOffset === null ? null : Date.now() + serverTimeOffset;
}

function send(msg: ClientMessage): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

export function sendPose(pose: Pose): void {
  send({ type: "pose", pose });
}

/** 自分の VRM アバターの CID をサーバーへ知らせる (null なら簡易アバターに戻す)。 */
export function sendSetAvatar(cid: string | null): void {
  send({ type: "set_avatar", cid });
}

/** 動画の再生状態をサーバーへ知らせる (サーバーが全員に配る)。 */
export function sendVideoControl(id: string, playing: boolean, time: number): void {
  send({ type: "video_control", id, playing, time });
}

export function sendPlaceImage(place: PlaceImage): void {
  if (!crdtMode) {
    send({ type: "place_image", ...place });
    return;
  }
  const objectId = place.objectId ?? crypto.randomUUID();
  const message: ClientMessage = { type: "place_image", ...place, objectId };
  if (!send(message)) queuePlacement(message, place.cid, place.name ?? "画像");
}

/** 入室時に選ばれたアバターのファイル。接続が確立するまで覚えておく。 */
let pendingAvatarFile: File | null = null;
/** アバターのアップロードが、どの接続のものかを識別する。切断後に完了しても状態を書き換えない。 */
let avatarEpoch = 0;
/** アップロードの進捗通知の間隔 (ミリ秒)。 */
const AVATAR_PROGRESS_INTERVAL_MS = 300;

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
  if (!crdtMode) {
    send({ type: "place_file", ...place });
    return;
  }
  const objectId = place.objectId ?? crypto.randomUUID();
  const message: ClientMessage = { type: "place_file", ...place, objectId };
  if (!send(message)) queuePlacement(message, place.cid, place.name);
}

/** 貼られた URL を置く (サーバーが取得して、画像・ファイル・リンクのいずれかにする)。 */
export function sendPlaceUrl(url: string, position: [number, number, number], yaw: number): void {
  if (!crdtMode) {
    send({ type: "place_url", url, position, yaw });
    return;
  }
  // URL の取り込みはサーバー依存なので、保留せずに明示的に断る
  if (!send({ type: "place_url", url, position, yaw })) {
    showNotice("サーバーに接続していないため、URL を取り込めません。サーバー復帰後に配置できます", 10_000);
  }
}

/** オフライン中に置こうとしたファイルを保留する (タブが生きている間、元のファイルを配り続ける)。 */
function queuePlacement(message: ClientMessage, cid: string, name: string): void {
  pendingPlacements.push({ message, cid, name });
  keepServing(cid);
  showNotice(`${name}: オフラインのため保留しました。接続が戻ると配置します`, 10_000);
}

/** 再接続時 (welcome のあと) に、保留した配置を同じ objectId で送り直す。 */
function flushPendingPlacements(): void {
  if (pendingPlacements.length === 0) return;
  const remaining: PendingPlacement[] = [];
  for (const placement of pendingPlacements) {
    if (!send(placement.message)) remaining.push(placement);
  }
  const sent = pendingPlacements.length - remaining.length;
  pendingPlacements = remaining;
  if (sent > 0) showNotice(`保留していた配置を ${sent} 件送信しました`);
}

export const sendGrabObject = (id: string): void => {
  if (crdtMode) {
    crdtWorld?.startGrab(id);
    return;
  }
  send({ type: "grab_object", id });
};
export const sendReleaseObject = (id: string): void => {
  if (crdtMode) {
    crdtWorld?.endGrab(id);
    return;
  }
  send({ type: "release_object", id });
};
export const sendDeleteObject = (id: string): void => {
  if (crdtMode) {
    crdtWorld?.deleteObject(id);
    return;
  }
  send({ type: "delete_object", id });
};
export const sendDuplicateObject = (id: string): void => {
  if (crdtMode) {
    crdtWorld?.duplicateObject(id);
    return;
  }
  send({ type: "duplicate_object", id });
};
export function sendMoveObject(
  id: string,
  position: [number, number, number],
  yaw: number,
  pitch = 0,
  scale = 1,
): void {
  if (crdtMode) {
    crdtWorld?.movePreview(id, position, yaw, pitch, scale);
    crdtWorld?.moveThrottled(id, position, yaw, pitch, scale);
    return;
  }
  send({ type: "move_object", id, position, yaw, pitch, scale });
}

/** 実験用: ボックスを 1 個作る (CRDT が有効なときだけ)。 */
export function createBoxAt(position: [number, number, number]): WorldObject | undefined {
  return crdtWorld?.createBox(position);
}

/** crdt-v1 の実験用: サーバーを通さず、リンクを文書へ直接置く。 */
export function placeLinkLocal(url: string, position: Vec3, yaw: number): boolean {
  if (!crdtMode || crdtWorld === null) return false;
  return crdtWorld.createLink(url, position, yaw) !== undefined;
}

/**
 * 自分が動かしたオブジェクトの位置を、手元の状態にも反映する。
 * 移動中の自分への配信 (echo) は無いので、離したときに古い位置へ戻って見えないようにする。
 */
export function applyLocalObjectPose(
  id: string,
  position: [number, number, number],
  yaw: number,
  pitch = 0,
  scale = 1,
): void {
  useNet.setState((s) => {
    const object = s.objects[id];
    return object ? { objects: { ...s.objects, [id]: { ...object, position, yaw, pitch, scale } } } : s;
  });
}

function reset(): void {
  // P2P transport を先に止める (Helia はこの後 stopIpfs で止まる)
  stopCrdtP2P();
  for (const id of [...prepareWaits.keys()]) settlePrepare(id, new Error("サーバーとの接続が切れました"));
  pendingUploads.clear();
  // 接続が切れたら、選ばれたアバターと、進行中のアップロードの結果は捨てる
  pendingAvatarFile = null;
  avatarEpoch += 1;
  resetInteraction();
  void stopIpfs();
  peerBuffers.clear();
  serverTimeOffset = null;
  socket = null;
}

export function connect(name: string, avatarFile?: File): void {
  if (socket) return;
  explicitExit = false;
  // 再接続でも同じ名前・アバターで join できるように覚えておく
  lastName = name;
  lastAvatarFile = avatarFile ?? null;
  // ソケットを開く前に、入室時に選ばれたアバターを覚えておく
  pendingAvatarFile = avatarFile ?? null;
  const keepObjects = requested && crdtWorld !== null;
  useNet.setState({
    status: "connecting",
    message: null,
    self: null,
    peers: {},
    objects: keepObjects ? useNet.getState().objects : {},
    notice: null,
    ipfs: keepObjects ? useNet.getState().ipfs : "idle",
    directPeers: 0,
    videoStates: {},
    sync: "legacy",
    localSaved: false,
    serverSaved: false,
    peerCount: 0,
  });
  openSocket();
}

function crdtCallbacks(): CrdtCallbacks {
  return {
    onObjects: (objects) => {
      // リモートで消えたオブジェクトをつかんだままにしない (ドラッグを止める)
      const grabbed = useInteraction.getState().grabbedId;
      if (grabbed !== null && objects[grabbed] === undefined) resetInteraction();
      useNet.setState({ objects });
      // サーバーが保持した (CRDT の文書に反映された) ファイル・画像は、もう配る必要がない
      for (const cid of uploadsToRelease(objects, useNet.getState().self?.id, isServing)) releaseUpload(cid);
    },
    onStatus: (status) =>
      useNet.setState({
        sync: status.sync,
        localSaved: status.localSaved,
        serverSaved: status.serverSaved,
        peerCount: status.peerCount,
      }),
    send: (msg) => send(msg),
    onWarning: (message) => showNotice(message, 12_000),
  };
}

function rememberCrdtPeer(ipfsPeerId: string): void {
  knownSyncPeers.add(ipfsPeerId);
  rememberSyncPeer(ipfsPeerId);
}

/**
 * CRDT 文書と IPFS の両方が準備できた後に、P2P transport を 1 回だけ開始する。
 * IPFS が使えない環境では WS だけのモードのまま続ける。
 */
function maybeStartWorldSyncP2P(): void {
  if (!crdtMode || crdtWorld === null || !p2pIpfsReady || p2pStart !== null) return;
  p2pStart = startWorldSyncP2P({
    getWorld: () => crdtWorld,
    log: (message) => console.info(`[crdt-p2p] ${message}`),
  })
    .catch((error: unknown) => {
      console.warn(`[crdt-p2p] start failed: ${describeError(error)}`, error);
    })
    .finally(() => {
      p2pStart = null;
    });
}

function stopCrdtP2P(): void {
  for (const peerId of knownSyncPeers) forgetSyncPeer(peerId);
  knownSyncPeers.clear();
  stopWorldSyncP2P();
  p2pIpfsReady = false;
  p2pStart = null;
}

/** welcome のあと、保存済み文書を開いて hello を送る。再接続では既存の文書を使う。 */
async function activateCrdt(info: CrdtSyncInfo, ws: WebSocket, epoch: number, peerCount: number): Promise<void> {
  try {
    if (!crdtWorld) {
      const world = await openCrdtWorld(info, () => useNet.getState().self?.id, crdtCallbacks());
      if (epoch !== connectionEpoch || socket !== ws || !crdtMode) {
        await world.close();
        return;
      }
      crdtWorld = world;
    } else {
      crdtWorld.notifyTransport(true);
    }
    crdtWorld.setPeerCount(peerCount);
    crdtWorld.sendHello();
    flushPendingPlacements();
    maybeStartWorldSyncP2P();
  } catch (error) {
    console.warn(`[crdt] open failed: ${describeError(error)}`, error);
    showNotice(`CRDT のローカル文書を開けませんでした: ${describeError(error)}`, 15_000);
  }
}

/** 指数バックオフ (1s, 2s, 4s, 8s, 10s + jitter)。明示的退出では呼ばない。 */
function scheduleReconnect(): void {
  if (explicitExit || !crdtMode || reconnectTimer !== undefined) return;
  const base = [1000, 2000, 4000, 8000, 10_000][Math.min(reconnectAttempt, 4)] ?? 10_000;
  reconnectAttempt++;
  const jitter = base * (Math.random() * 0.4 - 0.2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (explicitExit || !crdtMode || socket) return;
    openSocket();
  }, Math.max(0, Math.round(base + jitter)));
}

/** モード不一致などで、この接続の CRDT を畳む (文書の保存データは残す)。 */
function teardownCrdt(): void {
  crdtMode = false;
  stopCrdtP2P();
  const world = crdtWorld;
  crdtWorld = null;
  crdtInfo = null;
  pendingPlacements = [];
  if (world) void world.close();
}

function openSocket(): void {
  if (socket) return;
  const epoch = ++connectionEpoch;
  const ws = new WebSocket(WS_URL);
  socket = ws;
  let welcomed = false;

  ws.onopen = () => {
    if (socket !== ws) return;
    send({ type: "join", name: lastName });
  };

  ws.onmessage = (ev) => {
    // 退出後・別の接続のメッセージは無視する
    if (socket !== ws) return;
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
        const serverSync = msg.sync;
        if (serverSync?.mode === "crdt-v1" && !requested) {
          welcomed = false;
          teardownCrdt();
          useNet.setState({
            status: "idle",
            message: "サーバーは crdt-v1 です。VITE_SYNC_MODE=crdt-v1 でビルドしてください",
            self: null,
            peers: {},
            objects: {},
            sync: "legacy",
            localSaved: false,
            serverSaved: false,
            peerCount: 0,
          });
          ws.close();
          break;
        }
        if (requested && serverSync?.mode !== "crdt-v1") {
          welcomed = false;
          teardownCrdt();
          useNet.setState({
            status: "idle",
            message: "サーバーは legacy モードです。VITE_SYNC_MODE=crdt-v1 とサーバーの SYNC_MODE=crdt-v1 を揃えてください",
            self: null,
            peers: {},
            objects: {},
            sync: "legacy",
            localSaved: false,
            serverSaved: false,
            peerCount: 0,
          });
          ws.close();
          break;
        }

        welcomed = true;
        reconnectAttempt = 0;
        crdtNoticeShown = false;
        const peers: Record<string, PeerInfo> = {};
        for (const p of msg.peers) {
          peers[p.id] = { id: p.id, name: p.name, color: p.color, avatarCid: p.avatarCid };
        }
        // 先に入室していた人の libp2p ID に名前を結び付ける (ダウンロードの取得元の表示用)
        for (const peer of msg.peers) {
          if (!peer.ipfsPeerId) continue;
          rememberPeerName(peer.ipfsPeerId, peer.name);
          if (serverSync?.mode === "crdt-v1") rememberCrdtPeer(peer.ipfsPeerId);
        }
        p2pIpfsReady = useNet.getState().ipfs === "ready";

        if (serverSync?.mode === "crdt-v1") {
          crdtMode = true;
          // 別ワールド・別スキーマにはマージしない
          if (
            crdtWorld &&
            crdtInfo &&
            (crdtInfo.worldId !== serverSync.worldId || crdtInfo.schemaVersion !== serverSync.schemaVersion)
          ) {
            const stale = crdtWorld;
            crdtWorld = null;
            crdtInfo = null;
            stopCrdtP2P();
            void stale.close();
            useNet.setState({ objects: {} });
          }
          crdtInfo = serverSync;
          useNet.setState({
            status: "connected",
            self: msg.self,
            peers,
            videoStates: msg.videos ?? {},
            ipfs: useNet.getState().ipfs === "ready" ? "ready" : "starting",
            sync: "connecting",
            serverSaved: false,
            peerCount: Object.keys(peers).length,
          });
          void activateCrdt(serverSync, ws, epoch, Object.keys(peers).length);
        } else {
          crdtMode = false;
          crdtInfo = null;
          const objects: Record<string, WorldObject> = {};
          for (const o of msg.objects) objects[o.id] = o;
          useNet.setState({
            status: "connected",
            self: msg.self,
            peers,
            objects,
            videoStates: msg.videos ?? {},
            ipfs: "starting",
            sync: "legacy",
            localSaved: false,
            serverSaved: false,
            peerCount: Object.keys(peers).length,
          });
        }
        // 画像の取得・共有に使うブラウザ内 IPFS ノードを起動してサーバーに接続する (起動済みなら何もしない)
        startIpfs(msg.ipfs, msg.iceServers, (directPeers) => useNet.setState({ directPeers })).then(
          () => {
            if (epoch !== connectionEpoch) return;
            useNet.setState({ ipfs: "ready" });
            p2pIpfsReady = true;
            maybeStartWorldSyncP2P();
            // 他のブラウザから直接接続してもらえる状態になったら、自分のピア ID を知らせる
            waitForDialable()
              .then(
                (peerId) => send({ type: "ipfs_peer", peerId }),
                (err: unknown) => console.warn(`[ipfs] not dialable: ${describeError(err)}`, err),
              )
              // 自分のピア ID を知らせたあとで、選ばれていればアバターをアップロードする (入室は待たせない)
              .finally(() => void uploadPendingAvatar());
          },
          (err: unknown) => {
            if (epoch !== connectionEpoch) return;
            p2pIpfsReady = false;
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
        if (crdtMode) break; // CRDT では文書が正本 (object_* で上書きしない)
        const { object } = msg;
        useNet.setState((s) => ({ objects: { ...s.objects, [object.id]: object } }));
        if (object.kind === "file") {
          // ダウンロードのために待っていたファイルを、サーバーが保持した (または、取得できなくなった)
          if (object.stored) settlePrepare(object.id);
          else if (object.offline) settlePrepare(object.id, new Error("アップロードした人が退室しているため、取得できません"));
          // サーバーが保持したので、自分が配り続ける必要はなくなった
          if (!needsLocalFile(useNet.getState().objects, object.cid, useNet.getState().self?.id, isServing(object.cid))) releaseUpload(object.cid);
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
        if (crdtMode) break;
        const removed = useNet.getState().objects[msg.id];
        useNet.setState((s) => {
          const { [msg.id]: _removed, ...rest } = s.objects;
          const { [msg.id]: _video, ...videoStates } = s.videoStates;
          return { objects: rest, videoStates };
        });
        settlePrepare(msg.id, new Error("削除されました"));
        // 自分が配っていたファイルが、すべて削除された
        if (removed?.kind === "file" && !needsLocalFile(useNet.getState().objects, removed.cid, useNet.getState().self?.id, isServing(removed.cid))) {
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
        const peerName = useNet.getState().peers[msg.id]?.name;
        if (peerName) rememberPeerName(msg.ipfsPeerId, peerName); // ダウンロードの取得元の表示に使う
        void dialPeer(msg.ipfsPeerId).finally(() => {
          // IPFS のピア ID は WS の peer と違って安定している。退出するまで覚えておく
          if (crdtMode) rememberCrdtPeer(msg.ipfsPeerId);
        });
        break;
      }
      case "object_added": {
        if (crdtMode) break;
        const { object } = msg;
        useNet.setState((s) => ({ objects: { ...s.objects, [object.id]: object } }));
        if (object.kind === "box" || object.kind === "link") break; // ボックス・リンクは中身 (IPFS) を持たない
        const name = pendingUploads.get(object.cid);
        pendingUploads.delete(object.cid);
        if (object.kind === "file" && !object.stored && object.owner === useNet.getState().self?.id) {
          // 大きなファイル: 置いたあと、サーバーが全部を取得する。取り終えるまで、このタブが配り続ける
          keepServing(object.cid);
          showNotice(
            `${name ?? object.name}: 置きました。サーバーが取得しています。終わるまで、このタブを開いたままにしてください`,
            12_000,
          );
        } else if (object.kind === "file" && object.category === "video" && isServing(object.cid)) {
          // 映像は、他のブラウザに P2P で配れるように、このタブが開いている間は配り続ける
          keepServing(object.cid);
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
        const name =
          pendingUploads.get(msg.cid) ??
          Object.values(useNet.getState().objects).find((o): o is FileObject => o.kind === "file" && o.cid === msg.cid)?.name ??
          "ファイル";
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
      case "peer_avatar": {
        const { id, cid } = msg;
        // サーバーは設定した本人には送らないが、念のため自分なら self を更新する
        if (id === useNet.getState().self?.id) {
          useNet.setState((s) => {
            if (!s.self) return s;
            const self = { ...s.self };
            if (cid === null) delete self.avatarCid;
            else self.avatarCid = cid;
            return { self };
          });
          break;
        }
        useNet.setState((s) => {
          const peer = s.peers[id];
          if (!peer) return s;
          const next = { ...peer };
          if (cid === null) delete next.avatarCid;
          else next.avatarCid = cid;
          return { peers: { ...s.peers, [id]: next } };
        });
        break;
      }
      case "video_state": {
        const { id, playing, time, at } = msg;
        useNet.setState((s) => ({ videoStates: { ...s.videoStates, [id]: { playing, time, at } } }));
        break;
      }
      case "peer_joined": {
        const { id, name, color, avatarCid } = msg.peer;
        const next = { ...useNet.getState().peers, [id]: { id, name, color, avatarCid } };
        useNet.setState({ peers: next, peerCount: Object.keys(next).length });
        crdtWorld?.setPeerCount(Object.keys(next).length);
        break;
      }
      case "peer_left": {
        peerBuffers.delete(msg.id);
        const { [msg.id]: _removed, ...rest } = useNet.getState().peers;
        useNet.setState({ peers: rest, peerCount: Object.keys(rest).length });
        crdtWorld?.setPeerCount(Object.keys(rest).length);
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
      case "sync_init":
      case "sync_update":
      case "sync_part":
      case "sync_ack": {
        crdtWorld?.handleServerMessage(msg);
        break;
      }
      case "sync_error": {
        crdtWorld?.handleServerMessage(msg);
        showNotice(`同期エラー: ${msg.message}`, 10_000);
        break;
      }
      case "claim": {
        crdtWorld?.handleServerMessage(msg);
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
    if (socket !== ws) return;
    const prev = useNet.getState();
    if (crdtMode && !explicitExit) {
      // 文書・シーン・IPFS は止めない。transport だけを切り替えて再接続する。
      // P2P のリンクが残っていれば、そちらで同期を続ける
      const p2pCount = p2pPeerCount();
      crdtWorld?.setPeerCount(p2pCount);
      crdtWorld?.markP2PAvailable(p2pCount > 0);
      crdtWorld?.notifyTransport(false);
      peerBuffers.clear();
      serverTimeOffset = null;
      socket = null;
      useNet.setState({
        peers: {},
        peerCount: p2pCount,
        serverSaved: false,
        directPeers: 0,
        ...(crdtWorld ? {} : { sync: (p2pCount > 0 ? "p2p" : "offline") as CrdtSyncStatus }),
      });
      if (!crdtNoticeShown) {
        crdtNoticeShown = true;
        showNotice("サーバーとの接続が切れました。編集は続けられます", 10_000);
      }
      scheduleReconnect();
      return;
    }
    reset();
    useNet.setState({
      status: "idle",
      self: null,
      peers: {},
      objects: {},
      notice: null,
      ipfs: "idle",
      directPeers: 0,
      videoStates: {},
      sync: "legacy",
      localSaved: false,
      serverSaved: false,
      peerCount: 0,
      message:
        prev.message ??
        (welcomed ? "サーバーとの接続が切断されました" : "サーバーに接続できませんでした"),
    });
    explicitExit = false;
  };
}

export function disconnect(): void {
  explicitExit = true;
  connectionEpoch++;
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  reconnectAttempt = 0;
  crdtNoticeShown = false;

  // 明示的な退出では P2P transport を IPFS より先に止める
  stopCrdtP2P();

  if (crdtMode) {
    crdtMode = false;
    const world = crdtWorld;
    const ws = socket;
    crdtWorld = null;
    crdtInfo = null;
    pendingPlacements = [];
    socket = null;
    if (world) void world.close();
    reset();
    useNet.setState({
      status: "idle",
      self: null,
      peers: {},
      objects: {},
      message: null,
      notice: null,
      ipfs: "idle",
      directPeers: 0,
      videoStates: {},
      sync: "legacy",
      localSaved: false,
      serverSaved: false,
      peerCount: 0,
    });
    ws?.close();
    explicitExit = false;
    return;
  }

  socket?.close();
}

/**
 * 入室時に選ばれたアバターを IPFS に取り込み、CID をサーバーへ知らせる。
 * 入室の完了は待たせない (IPFS ノードの準備後、バックグラウンドで行う)。
 */
async function uploadPendingAvatar(): Promise<void> {
  const file = pendingAvatarFile;
  if (!file) return;
  // 一度だけ行う (再接続で再アップロードしない)
  pendingAvatarFile = null;
  if (file.size > MAX_AVATAR_BYTES) {
    showNotice("アバターが大きすぎます (64MB まで)");
    return;
  }
  const epoch = avatarEpoch;
  showNotice("アバターをアップロード中...", 60_000);
  let lastProgressAt = 0;
  let cid: string;
  try {
    cid = await addContent(file, {
      onProgress: (loaded, total) => {
        const now = Date.now();
        if (now - lastProgressAt < AVATAR_PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        const percent = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
        showNotice(percent === null ? "アバターをアップロード中..." : `アバターをアップロード中... ${percent}%`, 60_000);
      },
    });
  } catch (err) {
    if (epoch !== avatarEpoch) return;
    console.warn(`[avatar] upload failed: ${describeError(err)}`, err);
    showNotice(`アバターをアップロードできませんでした: ${describeError(err)}`, 10_000);
    return;
  }
  if (epoch !== avatarEpoch) {
    // 接続が切れたので、取り込んだ分は配るのをやめる
    releaseUpload(cid);
    return;
  }
  const previous = useNet.getState().self?.avatarCid;
  // このタブが開いている間は、他のユーザーが取得できるように配り続ける
  keepServing(cid);
  sendSetAvatar(cid);
  useNet.setState((s) => (s.self ? { self: { ...s.self, avatarCid: cid } } : s));
  if (previous && previous !== cid) releaseUpload(previous);
  showNotice("アバターを設定しました");
}

// 開発時のみ、E2E テストやコンソールから状態を確認できるようにする
if (import.meta.env.DEV) {
  (window as unknown as { __net: unknown }).__net = useNet;
}
