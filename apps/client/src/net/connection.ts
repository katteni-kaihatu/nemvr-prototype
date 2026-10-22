import { create } from "zustand";
import {
  formatBytes,
  MAX_AVATAR_BYTES,
  SPACE_SCHEMA_VERSION,
  SPACE_TEMPLATE_ID,
  type ClientMessage,
  type FileObject,
  type JsonValue,
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
import { poseFromEntity, projectEntities } from "../world/projection";
import { uploadsToRelease } from "./lazyUploads";
import { PoseBuffer } from "./interpolation";
import { SpaceReader } from "./spaceReader";
import { SpaceWriter } from "./spaceWriter";
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
  uploadImage,
  waitForDialable,
} from "./ipfs";

/** 補間のために描画を遅らせる時間 (2 tick 分)。 */
export const INTERPOLATION_DELAY_MS = 100;

const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  (location.protocol === "https:"
    ? `wss://${location.host}/ws`
    : `ws://${location.hostname}:8080`);

interface NetState {
  status: "idle" | "connecting" | "connected";
  message: string | null;
  self: PeerInfo | null;
  peers: Record<string, PeerInfo>;
  objects: Record<string, WorldObject>;
  notice: string | null;
  ipfs: "idle" | "starting" | "ready" | "error";
  directPeers: number;
  videoStates: Record<string, VideoPlaybackState>;
  peerCount: number;
  rtt: number | null;
  logs: string[];
  contentSources: Record<string, "ipfs" | "server">;
  downloads: Record<string, DownloadJob>;
}

export interface DownloadJob {
  id: string;
  label: string;
  loaded: number;
  total?: number;
  status: string;
  startedAt: number;
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
  peerCount: 0,
  rtt: null,
  logs: [],
  contentSources: {},
  downloads: {},
}));

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function showNotice(text: string, durationMs = 5000): void {
  clearTimeout(noticeTimer);
  useNet.setState({ notice: text });
  noticeTimer = setTimeout(() => useNet.setState({ notice: null }), durationMs);
}

/** Append one line to the multi-line HUD log (most recent 8 lines). */
export function showLog(text: string): void {
  const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  useNet.setState((s) => ({ logs: [...s.logs.slice(-7), `${time} ${text}`] }));
}

/** Record where an image's bytes came from. */
export function recordContentSource(cid: string, source: "ipfs" | "server", label?: string): void {
  useNet.setState((s) => ({
    contentSources: { ...s.contentSources, [cid]: source },
  }));
  showLog(`${label ?? cid}: 取得元 ${source === "ipfs" ? "IPFS" : "サーバー"}`);
}

/** Start, update, or clear (null) one active download entry. */
export function updateDownload(id: string, update: Partial<DownloadJob> | null): void {
  useNet.setState((s) => {
    const downloads = { ...s.downloads };
    if (update === null) {
      delete downloads[id];
    } else {
      downloads[id] = {
        id,
        label: id,
        loaded: 0,
        status: "取得中",
        startedAt: Date.now(),
        ...downloads[id],
        ...update,
      };
    }
    return { downloads };
  });
}

/** 毎フレーム参照される姿勢履歴。React state にはしない。 */
export const peerBuffers = new Map<string, PoseBuffer>();

let socket: WebSocket | null = null;
let serverTimeOffset: number | null = null;
let lastName = "";
let pendingAvatarFile: File | null = null;
let pendingAvatar: { commandId: string; cid: string; previous?: string } | null = null;
let avatarEpoch = 0;
let connectionEpoch = 0;
let selfEntityId: string | null = null;
let selfBase: PeerInfo | null = null;
let sessionId = "main";
let subscriptionFilter: { all: Array<{ dim: string; eq: JsonValue }> } = {
  all: [{ dim: "session.id", eq: "main" }],
};

const reader = new SpaceReader();
const writer = new SpaceWriter((message) => send(message));

const knownObjectIds = new Set<string>();
const dialedIpfsPeers = new Set<string>();
const lastPeerUpdate = new Map<string, number>();

let pingTimer: ReturnType<typeof setInterval> | undefined;
let pingSeq = 0;
const pendingPings = new Map<number, number>();

function startPing(): void {
  stopPing();
  if (socket?.readyState !== WebSocket.OPEN) return;
  sendPing();
  pingTimer = setInterval(sendPing, 1000);
}

function stopPing(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = undefined;
  pendingPings.clear();
  useNet.setState({ rtt: null });
}

function sendPing(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const id = ++pingSeq;
  pendingPings.set(id, performance.now());
  send({ type: "space_ping", id });
  if (pendingPings.size > 8) {
    const oldest = pendingPings.keys().next().value;
    if (typeof oldest === "number") pendingPings.delete(oldest);
  }
}

/** 現在のサーバー時刻の推定値 (ms)。welcome 未受信なら null。 */
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
  if (!selfEntityId) return;
  writer.pose(selfEntityId, pose.position, pose.head, pose.crouch ?? 0, pose.lean ?? 0);
}

/** 自分の VRM アバターの CID をサーバーへ知らせる (null なら簡易アバターに戻す)。 */
export function sendSetAvatar(cid: string | null): string {
  return writer.setAvatar(cid);
}

/** 動画の再生状態をサーバーへ知らせる (サーバーが全員に配る)。 */
export function sendVideoControl(id: string, playing: boolean, time: number): void {
  writer.video(id, playing, time);
}

export function sendPlaceImage(place: PlaceImage): void {
  const entityId = place.objectId ?? crypto.randomUUID();
  writer.createEntity(entityId, {
    "entity.kind": "image",
    "space.position": place.position,
    "space.yaw": place.yaw,
    ...(place.name ? { "content.name": place.name } : {}),
    "content.cid": place.cid,
    "content.width": place.width,
    "content.height": place.height,
  });
}

/** 入室時に選ばれたアバターのファイル。接続が確立するまで覚えておく。 */
const AVATAR_PROGRESS_INTERVAL_MS = 300;

/** サーバーへ転送中のアップロード (CID → ファイル名)。 */
const pendingUploads = new Map<string, string>();

/** サーバーが IPFS で取得できなかったときに、画像本体を送るための控え (CID → File)。 */
const fallbackImageFiles = new Map<string, File>();

export function expectImageFallback(cid: string, file: File): void {
  fallbackImageFiles.set(cid, file);
}

export function expectUpload(cid: string, name: string): void {
  pendingUploads.set(cid, name);
}

interface PrepareWait {
  object: FileObject;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const prepareWaits = new Map<string, PrepareWait>();
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

export function requestStored(object: FileObject): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wait: PrepareWait = { object, resolve, reject, timer: undefined as never };
    armPrepareTimer(wait);
    prepareWaits.set(object.id, wait);
    writer.requestFile(object.id);
  });
}

export function sendPlaceFile(place: PlaceFile): void {
  const entityId = place.objectId ?? crypto.randomUUID();
  writer.createEntity(entityId, {
    "entity.kind": "file",
    "space.position": place.position,
    "space.yaw": place.yaw,
    "content.cid": place.cid,
    "content.name": place.name,
  });
}

export function sendPlaceUrl(url: string, position: Vec3, yaw: number): void {
  writer.importUrl(crypto.randomUUID(), url, position, yaw);
}

export const sendGrabObject = (id: string): void => {
  writer.claimEntity(id);
};
export const sendReleaseObject = (id: string): void => {
  writer.releaseEntity(id);
};
export const sendDeleteObject = (id: string): void => {
  writer.deleteEntity(id);
};
export const sendDuplicateObject = (id: string): void => {
  writer.duplicateEntity(id, crypto.randomUUID());
};
export function sendMoveObject(
  id: string,
  position: Vec3,
  yaw: number,
  pitch = 0,
  scale = 1,
): void {
  writer.moveEntity(id, position, yaw, pitch, scale);
}

export function applyLocalObjectPose(
  id: string,
  position: Vec3,
  yaw: number,
  pitch = 0,
  scale = 1,
): void {
  const entity = reader.entities.get(id);
  if (entity) {
    entity.dimensions = {
      ...entity.dimensions,
      "space.position": position,
      "space.yaw": yaw,
      "space.pitch": pitch,
      "space.scale": scale,
    };
  }
  useNet.setState((s) => {
    const object = s.objects[id];
    return object ? { objects: { ...s.objects, [object.id]: { ...object, position, yaw, pitch, scale } } } : s;
  });
}

function reset(): void {
  for (const id of [...prepareWaits.keys()]) settlePrepare(id, new Error("サーバーとの接続が切れました"));
  pendingUploads.clear();
  fallbackImageFiles.clear();
  pendingAvatarFile = null;
  pendingAvatar = null;
  avatarEpoch += 1;
  reader.reset();
  knownObjectIds.clear();
  dialedIpfsPeers.clear();
  lastPeerUpdate.clear();
  resetInteraction();
  void stopIpfs();
  stopPing();
  peerBuffers.clear();
  serverTimeOffset = null;
  socket = null;
  selfEntityId = null;
  selfBase = null;
}

export function connect(name: string, avatarFile?: File): void {
  if (socket) return;
  lastName = name;
  pendingAvatarFile = avatarFile ?? null;
  useNet.setState({
    status: "connecting",
    message: null,
    self: null,
    peers: {},
    objects: {},
    notice: null,
    ipfs: "idle",
    directPeers: 0,
    videoStates: {},
    peerCount: 0,
    rtt: null,
    logs: [],
    contentSources: {},
    downloads: {},
  });
  openSocket();
}

function openSocket(): void {
  if (socket) return;
  const epoch = ++connectionEpoch;
  const ws = new WebSocket(WS_URL);
  socket = ws;
  let welcomed = false;

  ws.onopen = () => {
    if (socket !== ws) return;
    send({
      type: "space_join",
      name: lastName,
      templateId: SPACE_TEMPLATE_ID,
      schemaVersion: SPACE_SCHEMA_VERSION,
    });
  };

  ws.onmessage = (ev) => {
    if (socket !== ws) return;
    if (typeof ev.data !== "string") return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    welcomed = handleMessage(msg, ws, epoch) || welcomed;
  };

  ws.onclose = () => {
    if (socket !== ws) return;
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
      peerCount: 0,
      rtt: null,
      logs: [],
      contentSources: {},
      downloads: {},
      message:
        useNet.getState().message ??
        (welcomed ? "サーバーとの接続が切断されました" : "サーバーに接続できませんでした"),
    });
  };
}

function handleMessage(msg: ServerMessage, ws: WebSocket, epoch: number): boolean {
  switch (msg.type) {
    case "space_pong": {
      const sent = pendingPings.get(msg.id);
      if (sent !== undefined) {
        pendingPings.delete(msg.id);
        const sample = Math.max(0, Math.round(performance.now() - sent));
        useNet.setState((s) => ({
          rtt: s.rtt === null ? sample : Math.max(1, Math.round(s.rtt * 0.7 + sample * 0.3)),
        }));
      }
      return true;
    }

    case "space_welcome": {
      if (epoch !== connectionEpoch || socket !== ws) return false;
      reader.applyWelcome(msg);
      serverTimeOffset = msg.at - Date.now();
      sessionId = msg.sessionId;
      subscriptionFilter = { all: [{ dim: "session.id", eq: sessionId }] };
      selfBase = { id: msg.self.peerId, name: msg.self.name, color: msg.self.color };
      selfEntityId = msg.self.entityId;
      useNet.setState({ status: "connected", ipfs: "starting" });
      showLog("サーバーに接続しました");
      startPing();
      refreshWorld(msg.at);

      startIpfs(msg.ipfs, msg.iceServers, (directPeers) => useNet.setState({ directPeers })).then(
        () => {
          if (epoch !== connectionEpoch) return;
          useNet.setState({ ipfs: "ready" });
          waitForDialable()
            .then((peerId) => {
              if (selfEntityId) writer.ipfsPeerId(selfEntityId, peerId);
            })
            .catch((err: unknown) => console.warn(`[ipfs] not dialable: ${describeError(err)}`, err))
            .finally(() => void uploadPendingAvatar());
        },
        (err: unknown) => {
          if (epoch !== connectionEpoch) return;
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
      return true;
    }

    case "space_snapshot": {
      reader.applySnapshot(msg);
      refreshWorld(msg.at);
      return true;
    }

    case "space_delta": {
      if (!reader.applyDelta(msg)) {
        // seq が飛んだ (フィルタで落ちた分は seq に影響しない)。購読をやり直す
        send({ type: "space_subscribe", subscriptionId: reader.subscriptionId, filter: subscriptionFilter });
        return true;
      }
      refreshWorld(msg.at);
      return true;
    }

    case "space_ack": {
      if (pendingAvatar && msg.commandId === pendingAvatar.commandId) {
        pendingAvatar = null;
        showNotice("アバターを設定しました", 4000);
      }
      return true;
    }

    case "space_error": {
      if (pendingAvatar && msg.commandId === pendingAvatar.commandId) {
        const failed = pendingAvatar;
        pendingAvatar = null;
        releaseUpload(failed.cid);
        useNet.setState((s) => (s.self ? { self: { ...s.self, avatarCid: failed.previous } } : s));
        showNotice(`アバターを設定できませんでした: ${msg.message}`, 10_000);
        return true;
      }
      if (msg.code === "held_by_other") {
        useInteraction.setState({ grabbedId: null });
      }
      if (useNet.getState().status === "connected") showNotice(msg.message, 8_000);
      else useNet.setState({ message: msg.message });
      return true;
    }

    case "file_progress": {
      handleFileProgress(msg);
      return true;
    }

    case "file_failed": {
      if (msg.role === "fallback" && msg.cid) {
        const file = fallbackImageFiles.get(msg.cid);
        if (file) {
          fallbackImageFiles.delete(msg.cid);
          showNotice(
            "IPFS で画像を共有できなかったため、サーバー経由に切り替えています...",
            60_000,
          );
          void uploadImage(file)
            .then(() => showNotice("サーバー経由に切り替えました。他の人にも表示されます", 8_000))
            .catch((err: unknown) => {
              console.warn(`[image] server fallback failed: ${describeError(err)}`, err);
              showNotice(`画像をサーバーへ送れませんでした: ${describeError(err)}`, 10_000);
            });
          return true;
        }
      }

      const object =
        (msg.entityId ? useNet.getState().objects[msg.entityId] : undefined) ??
        Object.values(useNet.getState().objects).find(
          (o): o is FileObject => o.kind === "file" && Boolean(msg.cid) && o.cid === msg.cid,
        );
      if (object) settlePrepare(object.id, new Error(msg.message));
      showNotice(`${object?.kind === "file" ? object.name : "ファイル"}: ${msg.message}`, 10_000);
      return true;
    }

    case "space_query_result": {
      return true;
    }
  }
}

function handleFileProgress(msg: Extract<ServerMessage, { type: "file_progress" }>): void {
  const objects = useNet.getState().objects;
  const object =
    (msg.entityId ? objects[msg.entityId] : undefined) ??
    Object.values(objects).find(
      (o): o is FileObject => o.kind === "file" && Boolean(msg.cid) && o.cid === msg.cid,
    );

  if (msg.role === "place" && msg.cid) holdUpload(msg.cid);
  if (msg.cid) {
    for (const wait of prepareWaits.values()) if (wait.object.cid === msg.cid) armPrepareTimer(wait);
  }

  const name =
    (msg.cid ? pendingUploads.get(msg.cid) : undefined) ??
    (object?.kind === "file" ? object.name : undefined) ??
    (msg.cid ? [...prepareWaits.values()].find((w) => w.object.cid === msg.cid)?.object.name : undefined) ??
    "ファイル";

  if (msg.queued) {
    showNotice(`${name}: ${msg.role === "prepare" ? "ダウンロードの準備" : "順番待ち"}`, 15_000);
    return;
  }

  const amount = msg.total
    ? `${Math.min(100, Math.floor((msg.loaded / msg.total) * 100))}% (${formatBytes(msg.loaded)} / ${formatBytes(msg.total)})`
    : formatBytes(msg.loaded);

  if (msg.role === "prepare") {
    showNotice(`${name}: ダウンロードの準備中 (サーバーが、置いた人から取得しています) ${amount}`, 8_000);
  } else {
    showNotice(`${name}: サーバーへ転送中 ${amount}`, 8_000);
  }
}

function refreshWorld(at: number): void {
  const projected = projectEntities(reader.values());
  const selfId = selfEntityId;
  const selfPeer = selfId ? projected.peers[selfId] : undefined;
  const peers = { ...projected.peers };
  if (selfId) delete peers[selfId];

  const objects = projected.objects;
  const currentSelf = useNet.getState().self;

  if (pendingAvatar && selfPeer?.avatarCid === pendingAvatar.cid) {
    pendingAvatar = null;
    showNotice("アバターを設定しました", 4000);
  }

  const self = selfBase
    ? {
        ...selfBase,
        ...(selfPeer ?? {}),
        id: selfBase.id,
        name: selfPeer?.name ?? selfBase.name,
        color: selfPeer?.color ?? selfBase.color,
        avatarCid: selfPeer?.avatarCid ?? currentSelf?.avatarCid,
      }
    : selfPeer ?? null;

  useNet.setState({
    self,
    peers,
    objects,
    videoStates: projected.videoStates,
    peerCount: Object.keys(peers).length + 1,
  });

  for (const entity of reader.values()) {
    const dims = entity.dimensions;
    if (dims["entity.kind"] !== "peer") continue;
    if (entity.id === selfId) continue;

    const peer = projected.peers[entity.id];
    const ipfsPeerId = typeof dims["peer.ipfsPeerId"] === "string" ? (dims["peer.ipfsPeerId"] as string) : null;
    if (peer && ipfsPeerId) {
      rememberPeerName(ipfsPeerId, peer.name);
      if (!dialedIpfsPeers.has(ipfsPeerId)) {
        dialedIpfsPeers.add(ipfsPeerId);
        void dialPeer(ipfsPeerId);
      }
    }

    const updatedAt = typeof dims["time.updatedAt"] === "number" ? (dims["time.updatedAt"] as number) : at;
    if (updatedAt <= (lastPeerUpdate.get(entity.id) ?? 0)) continue;
    lastPeerUpdate.set(entity.id, updatedAt);

    let buffer = peerBuffers.get(entity.id);
    if (!buffer) peerBuffers.set(entity.id, (buffer = new PoseBuffer()));
    buffer.push(updatedAt, poseFromEntity(entity));
  }

  const activePeerIds = new Set(Object.keys(peers));
  for (const id of [...peerBuffers.keys()]) {
    if (id === selfId || !activePeerIds.has(id)) {
      peerBuffers.delete(id);
      lastPeerUpdate.delete(id);
    }
  }

  const interaction = useInteraction.getState();
  const grabbed = interaction.grabbedId;
  if (grabbed !== null) {
    const object = objects[grabbed];
    if (!object) resetInteraction();
    else if (object.heldBy && object.heldBy !== selfId) useInteraction.setState({ grabbedId: null });
  }
  if (interaction.hoverId && !objects[interaction.hoverId]) useInteraction.setState({ hoverId: null });
  if (interaction.menuTargetId && !objects[interaction.menuTargetId]) useInteraction.setState({ menuTargetId: null });

  for (const object of Object.values(objects)) {
    if (object.kind === "file") {
      if (object.stored) settlePrepare(object.id);
      else if (object.offline) settlePrepare(object.id, new Error("アップロードした人が退室しているため、取得できません"));
    }

    if (!knownObjectIds.has(object.id)) {
      knownObjectIds.add(object.id);
      if (object.kind === "file") {
        const name = pendingUploads.get(object.cid);
        pendingUploads.delete(object.cid);
        if (!object.stored && object.owner === selfId) {
          keepServing(object.cid);
          showNotice(
            `${name ?? object.name}: 置きました。サーバーが取得しています。終わるまで、このタブを開いたままにしてください`,
            12_000,
          );
        } else if (object.category === "video" && isServing(object.cid)) {
          keepServing(object.cid);
        }
      } else if (object.kind === "image") {
        const name = pendingUploads.get(object.cid);
        pendingUploads.delete(object.cid);
        if (object.stored) fallbackImageFiles.delete(object.cid);
        if (!object.stored && object.owner === selfId) keepServing(object.cid);
        if (name) showNotice(`${name}: 置きました`, 4_000);
      }
    }
  }

  const objectCids = new Set<string>();
  for (const object of Object.values(objects)) {
    if (object.kind === "file" || object.kind === "image") objectCids.add(object.cid);
  }
  for (const cid of fallbackImageFiles.keys()) {
    if (!objectCids.has(cid)) fallbackImageFiles.delete(cid);
  }

  for (const cid of uploadsToRelease(objects, selfId ?? undefined, isServing)) releaseUpload(cid);
}

export function disconnect(): void {
  connectionEpoch++;
  socket?.close();
  socket = null;
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
    peerCount: 0,
    rtt: null,
    logs: [],
    contentSources: {},
    downloads: {},
  });
}

async function uploadPendingAvatar(): Promise<void> {
  const file = pendingAvatarFile;
  if (!file) return;
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
    releaseUpload(cid);
    return;
  }
  const previous = useNet.getState().self?.avatarCid;
  keepServing(cid);
  const commandId = sendSetAvatar(cid);
  pendingAvatar = { commandId, cid, previous };
  useNet.setState((s) => (s.self ? { self: { ...s.self, avatarCid: cid } } : s));
  if (previous && previous !== cid) releaseUpload(previous);
  showNotice("アバターを設定しています...", 60_000);
}

// 開発時のみ、E2E テストやコンソールから状態を確認できるようにする
if (import.meta.env.DEV) {
  (window as unknown as { __net: unknown }).__net = useNet;
}
