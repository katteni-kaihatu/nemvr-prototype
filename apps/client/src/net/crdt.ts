import {
  FILE_ICON_WIDTH,
  MAX_OBJECTS,
  type ClientMessage,
  type CrdtSyncInfo,
  type ServerMessage,
  type Vec3,
  type WorldObject,
} from "@proto/protocol";
import {
  TransferAssembler,
  WorldDoc,
  encodeTransfer,
  fromBase64,
  stateVectorEquals,
  toBase64,
  type ObjectMetadataPatch,
} from "@proto/world-sync";
import { openUpdateStore, type UpdateStore } from "./idb";

export type CrdtSyncStatus =
  | "connecting"
  | "online"
  | "p2p"
  | "offline"
  | "resyncing"
  | "save-failed"
  | "sync-error";

export interface CrdtStatus {
  sync: CrdtSyncStatus;
  localSaved: boolean;
  serverSaved: boolean;
  peerCount: number;
}

export interface CrdtCallbacks {
  onObjects(objects: Record<string, WorldObject>): void;
  onStatus(status: CrdtStatus): void;
  /** false のときはソケットが開いていない (ローカル編集は続ける)。 */
  send(msg: ClientMessage): boolean;
  /** 保存に失敗したときの、一度だけの案内 (任意)。 */
  onWarning?: (message: string) => void;
}

export interface CrdtPeerTransport {
  /** 文書の更新を、つながっている P2P ピアへ送る (exceptPeerId は受信元)。 */
  send(update: Uint8Array, exceptPeerId?: string): void;
  /** つかみ claim などの一時メッセージを P2P ピアへ送る。 */
  sendEphemeral(msg: ClientMessage): void;
}

export interface CrdtWorldOptions {
  store?: UpdateStore;
  /** IDB が使えずメモリ保存に切り替わった場合。 */
  memoryOnly?: boolean;
  actorId?: string;
  sessionId?: string;
  now?: () => number;
  idFactory?: () => string;
  compactEvery?: number;
  compactBytes?: number;
}

type TransportStatus = "connecting" | "online" | "offline" | "resyncing";

interface Preview {
  position: Vec3;
  yaw: number;
  pitch: number;
  scale: number;
}

interface RemoteClaim {
  id: string;
  peerId: string;
  sessionId: string;
  seq: number;
  until: number;
}

interface PersistThrottle {
  lastAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface PeerOrigin {
  kind: "p2p";
  peerId: string;
}

function isPeerOrigin(origin: unknown): origin is PeerOrigin {
  if (typeof origin !== "object" || origin === null) return false;
  const value = origin as { kind?: unknown; peerId?: unknown };
  return value.kind === "p2p" && typeof value.peerId === "string" && value.peerId.length > 0;
}

/** Yjs は差分が無くても 2 バイト ([0, 0]) を返すことがある。 */
function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length === 0 || (update.length === 2 && update[0] === 0 && update[1] === 0);
}

/**
 * 圧縮時に、このタブのスナップショットと、他のタブが書いた既存の行を 1 つにまとめる。
 * IndexedDB の readwrite トランザクションの中から同期で呼ばれる (await しない)。
 * クライアントに yjs の直接依存を増やさないため、Y.mergeUpdates の代わりに一時的な
 * WorldDoc へ全部適用して 1 つの更新にエンコードする (結果は同じ)。
 * 壊れた行はスキップし、読めた更新だけを残す。
 */
export function mergeUpdatesForCompaction(snapshot: Uint8Array, existing: Uint8Array[]): Uint8Array {
  if (existing.length === 0) return snapshot;
  const merged = new WorldDoc({ actorId: "compact" });
  try {
    for (const update of existing) {
      if (update.length === 0) continue;
      try {
        merged.applyUpdate(update);
      } catch {
        // 壊れた行は捨てる (残りの行とスナップショットは失わない)
      }
    }
    merged.applyUpdate(snapshot);
    return merged.encodeUpdate();
  } finally {
    merged.destroy();
  }
}

const ACTOR_KEY = "proto-crdt:actor";
const BASE64_UPDATE_LIMIT = 48 * 1024;
const MOVE_COMMIT_INTERVAL_MS = 1000;
const PREVIEW_INTERVAL_MS = 1000 / 20;
const CLAIM_TTL_MS = 3000;
const CLAIM_HEARTBEAT_MS = 1000;
const CLAIM_PRUNE_MS = 1000;
const COMPACT_EVERY_UPDATES = 200;
const COMPACT_BYTES = 1024 * 1024;
const BOX_COLORS = ["#d9534f", "#5bc0de", "#5cb85c", "#f0ad4e", "#9b59b6"] as const;

let crdtActive = false;
let activeWorld: CrdtWorld | null = null;
let openToken = 0;

export function isCrdtActive(): boolean {
  return crdtActive;
}

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** actorId はタブをまたいで同じ (どのタブの編集かを区別する)。 */
function loadActorId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(ACTOR_KEY);
    if (existing) return existing;
    const id = randomId();
    globalThis.localStorage?.setItem(ACTOR_KEY, id);
    return id;
  } catch {
    return randomId();
  }
}

/** 保存キーは接続先・ワールド・スキーマで分ける (別ワールドを混ぜない)。 */
export function crdtDatabaseName(info: CrdtSyncInfo): string {
  const host = typeof location === "undefined" ? "local" : location.host;
  return `proto-crdt:${host}:${info.worldId}:${info.schemaVersion}`;
}

/** IDB が無いときの、プロセス内だけの保存先。 */
class MemoryUpdateStore implements UpdateStore {
  private updates: Uint8Array[] = [];

  async load(): Promise<Uint8Array[]> {
    return this.updates.map((update) => new Uint8Array(update));
  }

  async append(update: Uint8Array): Promise<void> {
    this.updates.push(new Uint8Array(update));
  }

  async compact(
    snapshot: Uint8Array,
    merge?: (snapshot: Uint8Array, existing: Uint8Array[]) => Uint8Array,
  ): Promise<void> {
    const existing = this.updates.map((update) => new Uint8Array(update));
    const next = merge ? merge(snapshot, existing) : snapshot;
    this.updates = [new Uint8Array(next)];
  }

  close(): void {
    // 何もしない
  }
}

/**
 * ブラウザ側の CRDT レプリカ。Yjs 文書と IndexedDB 保存、WebSocket 経由の差分同期、
 * ローカルの作成・移動・複製・削除、つかみ claim を持つ。
 */
export class CrdtWorld {
  readonly info: CrdtSyncInfo;

  private readonly world: WorldDoc;
  private readonly store: UpdateStore;
  private readonly memoryOnly: boolean;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly selfId: () => string | undefined;
  private readonly callbacks: CrdtCallbacks;
  private readonly sessionId: string;
  private readonly compactEvery: number;
  private readonly compactBytes: number;

  private transport: TransportStatus = "connecting";
  private localSaved = false;
  private serverSaved = false;
  private peerCount = 0;
  /** P2P の hello が成立したリンクがあるか (WS が切れている間の状態判定に使う)。 */
  private p2pAvailable = false;
  private peerTransport: CrdtPeerTransport | null = null;
  private saveFailed = false;
  /** 致命的な同期エラー (worldId / schema の不一致など)。再接続しても消さない。 */
  private syncError: string | null = null;
  private warnedStorage = false;
  private warnedCorrupt = false;
  private warnedCompaction = false;
  private closed = false;
  private closing = false;

  private unsubscribe: (() => void) | undefined;
  private persistence: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private updatesSinceCompact = 0;
  private bytesSinceCompact = 0;
  private compactScheduled = false;
  /** append に失敗した更新がある (スナップショットで埋め直す必要がある)。 */
  private appendDirty = false;
  private snapshotRetryScheduled = false;
  /** 読み込みで壊れた行を飛ばした。直後の圧縮は 1 回見送る。 */
  private deferCompaction = false;

  private readonly previews = new Map<string, Preview>();
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPreviewAt = 0;
  private readonly throttles = new Map<string, PersistThrottle>();

  private readonly localClaims = new Set<string>();
  private readonly remoteClaims = new Map<string, Map<string, RemoteClaim>>();
  private claimSeq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  private readonly assembler = new TransferAssembler();

  private lastStatus: CrdtStatus | undefined;

  constructor(
    info: CrdtSyncInfo,
    selfId: () => string | undefined,
    callbacks: CrdtCallbacks,
    options: CrdtWorldOptions = {},
  ) {
    this.info = info;
    this.selfId = selfId;
    this.callbacks = callbacks;
    this.store = options.store ?? new MemoryUpdateStore();
    this.memoryOnly = options.memoryOnly ?? false;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? randomId;
    this.sessionId = options.sessionId ?? randomId();
    this.compactEvery = options.compactEvery ?? COMPACT_EVERY_UPDATES;
    this.compactBytes = options.compactBytes ?? COMPACT_BYTES;
    this.world = new WorldDoc({ actorId: options.actorId ?? loadActorId() });
  }

  /** 保存済みの更新を読み込み、そのあとで変更の購読を始める。 */
  async init(): Promise<void> {
    try {
      const updates = await this.store.load();
      let skipped = 0;
      for (const update of updates) {
        if (update.length === 0) continue;
        try {
          this.world.applyUpdate(update, "load");
        } catch {
          // 壊れた行だけを飛ばし、残りの有効な行は読み込み続ける
          skipped++;
        }
      }
      if (skipped > 0) {
        // 有効な行を消さないように、直後の圧縮は見送る (次の機会にまとめる)
        this.deferCompaction = true;
        if (!this.warnedCorrupt) {
          this.warnedCorrupt = true;
          console.warn(`[crdt] skipped ${skipped} corrupt local update(s) while loading`);
        }
      }
    } catch (error) {
      this.markSaveFailed(error);
    }
    this.unsubscribe = this.world.onUpdate((update, origin) => this.onDocUpdate(update, origin));
    if (!this.memoryOnly && !this.saveFailed) this.localSaved = true;
    if (this.memoryOnly) {
      this.saveFailed = true;
      this.localSaved = false;
      this.warnStorage();
    }
    this.publishProjection();
    this.emitStatus(true);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** P2P の claim に載せる、WebSocket 側の自分の peerId (未入室なら undefined)。 */
  selfPeerId(): string | undefined {
    return this.selfId();
  }

  /** P2P の handshake などで見つかった、致命的な同期エラーを HUD に出す。 */
  reportSyncError(message: string): void {
    this.syncError = message;
    this.emitStatus();
  }

  stateVector(): Uint8Array {
    return this.world.encodeStateVector();
  }

  stateVectorBase64(): string {
    return toBase64(this.stateVector());
  }

  /** P2P の hello / ack で使う、現在の state vector (base64)。 */
  getStateVectorBase64(): string {
    return this.stateVectorBase64();
  }

  /** 相手の state vector に足りない更新を返す。base64 が不正なら null。 */
  diffForStateVector(vectorBase64: string): Uint8Array | null {
    const vector = fromBase64(vectorBase64);
    if (vector === null) return null;
    try {
      return this.encodeLocalDiffForRemote(vector);
    } catch {
      return null;
    }
  }

  /** 相手の state vector とローカルの差分 (Yjs の更新)。 */
  encodeLocalDiffForRemote(remoteVector: Uint8Array): Uint8Array {
    // 空の state vector は「何も持っていない」(Yjs は空 vector を受け付けない)
    return remoteVector.length === 0 ? this.world.encodeUpdate() : this.world.encodeUpdate(remoteVector);
  }

  /** P2P の受信更新。origin を経路として区別し、送信元へは即時エコーしない。 */
  applyPeerUpdate(update: Uint8Array, peerId: string): void {
    if (update.length === 0 || typeof peerId !== "string" || peerId.length === 0) return;
    const origin: PeerOrigin = { kind: "p2p", peerId };
    this.world.applyUpdate(update, origin);
  }

  setPeerTransport(transport: CrdtPeerTransport | null): void {
    this.peerTransport = transport;
  }

  sendHello(): boolean {
    return this.callbacks.send({
      type: "sync_hello",
      worldId: this.info.worldId,
      schemaVersion: this.info.schemaVersion,
      stateVector: this.stateVectorBase64(),
    });
  }

  createBox(position: Vec3): WorldObject | undefined {
    if (this.world.count() >= MAX_OBJECTS) return undefined;
    const color = BOX_COLORS[this.world.count() % BOX_COLORS.length]!;
    const object: WorldObject = {
      id: this.idFactory(),
      kind: "box",
      position: [position[0], position[1], position[2]],
      yaw: 0,
      size: 1,
      color,
    };
    return this.world.createObject(object) ? object : undefined;
  }

  createLink(url: string, position: Vec3, yaw: number): WorldObject | undefined {
    if (this.world.count() >= MAX_OBJECTS) return undefined;
    const object: WorldObject = {
      id: this.idFactory(),
      kind: "link",
      url,
      position: [position[0], position[1], position[2]],
      yaw,
    };
    return this.world.createObject(object) ? object : undefined;
  }

  /** ドラッグ中の見た目だけを更新する (永続化しない)。描画へは最大 20Hz で流す。 */
  movePreview(id: string, position: Vec3, yaw: number, pitch = 0, scale = 1): void {
    this.previews.set(id, { position: [position[0], position[1], position[2]], yaw, pitch, scale });
    const now = this.now();
    if (now - this.lastPreviewAt >= PREVIEW_INTERVAL_MS) {
      this.lastPreviewAt = now;
      this.publishProjection();
      return;
    }
    if (this.previewTimer !== undefined) return;
    const delay = Math.max(0, PREVIEW_INTERVAL_MS - (now - this.lastPreviewAt));
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      this.lastPreviewAt = this.now();
      this.publishProjection();
    }, delay);
  }

  /** 確定を書き込む (離したとき・スロットル経過時)。 */
  commitMove(id: string, position: Vec3, yaw: number, pitch = 0, scale = 1): void {
    this.clearThrottle(id);
    this.previews.delete(id);
    this.world.moveObject(id, position, yaw, pitch, { scale });
    this.publishProjection();
  }

  /** 自動の確定は最大 1Hz。最初の変更だけはすぐに確定し、以後は 1 秒ごとに最新値へ。 */
  moveThrottled(id: string, position: Vec3, yaw: number, pitch = 0, scale = 1): void {
    this.movePreview(id, position, yaw, pitch, scale);
    const state = this.throttles.get(id);
    const now = this.now();
    if (state?.timer !== undefined) return;
    if (state === undefined || now - state.lastAt >= MOVE_COMMIT_INTERVAL_MS) {
      this.commitMove(id, position, yaw, pitch, scale);
      this.throttles.set(id, { lastAt: now });
      return;
    }
    const delay = Math.max(0, MOVE_COMMIT_INTERVAL_MS - (now - state.lastAt));
    const timer = setTimeout(() => {
      const current = this.throttles.get(id);
      if (!current || current.timer !== timer) return;
      this.throttles.delete(id);
      const preview = this.previews.get(id);
      if (!preview) return;
      this.commitMove(id, preview.position, preview.yaw, preview.pitch, preview.scale);
      this.throttles.set(id, { lastAt: this.now() });
    }, delay);
    this.throttles.set(id, { lastAt: state.lastAt, timer });
  }

  deleteObject(id: string): void {
    this.clearPreview(id);
    this.clearThrottle(id);
    this.dropLocalClaim(id);
    this.world.deleteObject(id);
  }

  duplicateObject(id: string): WorldObject | undefined {
    if (this.world.count() >= MAX_OBJECTS) return undefined;
    const source = this.world.getObject(id);
    if (!source) return undefined;
    const side =
      (source.kind === "box" ? source.size + 0.2 : source.kind === "file" ? FILE_ICON_WIDTH + 0.15 : 0.6) *
      (source.scale ?? 1);
    const normal = 0.05;
    const copy: WorldObject = {
      ...source,
      id: this.idFactory(),
      position: [
        source.position[0] + Math.cos(source.yaw) * side + Math.sin(source.yaw) * normal,
        source.position[1],
        source.position[2] - Math.sin(source.yaw) * side + Math.cos(source.yaw) * normal,
      ],
    };
    delete copy.heldBy;
    return this.world.createObject(copy) ? copy : undefined;
  }

  setFileMetadata(id: string, patch: ObjectMetadataPatch): boolean {
    return this.world.setMetadata(id, patch);
  }

  startGrab(id: string): void {
    if (this.localClaims.has(id)) return;
    this.localClaims.add(id);
    this.sendClaim(id);
    if (this.heartbeatTimer === undefined) {
      this.heartbeatTimer = setInterval(() => {
        if (this.localClaims.size === 0) {
          this.stopHeartbeat();
          return;
        }
        for (const claimed of this.localClaims) this.sendClaim(claimed);
      }, CLAIM_HEARTBEAT_MS);
    }
    this.publishProjection();
  }

  endGrab(id: string): void {
    const preview = this.previews.get(id);
    if (preview) this.commitMove(id, preview.position, preview.yaw, preview.pitch, preview.scale);
    if (this.localClaims.delete(id)) {
      this.sendEphemeral({ type: "claim_release", id, sessionId: this.sessionId });
    }
    if (this.localClaims.size === 0) this.stopHeartbeat();
    this.publishProjection();
  }

  handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "sync_init":
      case "sync_update": {
        const update = fromBase64(msg.update);
        if (!update) return;
        this.applyRemote(update);
        this.markOnline();
        break;
      }
      case "sync_part": {
        const { type: _type, ...part } = msg;
        const update = this.assembler.accept(part);
        if (update) this.applyRemote(update);
        this.markOnline();
        break;
      }
      case "sync_ack": {
        const vector = fromBase64(msg.stateVector);
        if (!vector) return;
        // 既に同じ state vector なら、サーバーは追い付いている。ここで差分を作ると
        // delete set だけの更新を返して ack が往復し続けるので、何も送らない。
        if (stateVectorEquals(vector, this.world.encodeStateVector())) {
          this.serverSaved = true;
          this.markOnline();
          this.emitStatus();
          break;
        }
        // サーバーの vector に足りないローカルの更新 (オフライン中の編集) を送り返す。
        // ここで初めて再接続後のギャップが埋まる。
        let diff: Uint8Array;
        try {
          diff = this.encodeLocalDiffForRemote(vector);
        } catch {
          // 解釈できない vector では何もしない (接続を壊さない)
          return;
        }
        if (!isEmptyUpdate(diff)) {
          this.serverSaved = false;
          this.sendToServer(diff);
        } else {
          this.serverSaved = false;
        }
        this.markOnline();
        this.emitStatus();
        break;
      }
      case "sync_error":
        console.warn(`[crdt] sync error: ${msg.message}`);
        this.syncError = msg.message;
        this.emitStatus();
        break;
      case "claim":
        this.acceptRemoteClaim(msg);
        break;
      default:
        break;
    }
  }

  /** 接続経路の状態。オンライン復帰直後は、最初の sync_init / ack まで再同期中にする。 */
  notifyTransport(online: boolean): void {
    if (this.closed) return;
    if (online) {
      if (this.transport === "offline") this.transport = "resyncing";
      // 再接続では、サーバーが追い付くまで保存済みとはしない
      this.serverSaved = false;
    } else {
      this.transport = "offline";
      this.serverSaved = false;
    }
    this.emitStatus();
  }

  setPeerCount(count: number): void {
    const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (this.peerCount === next) return;
    this.peerCount = next;
    if (this.transport === "offline") this.serverSaved = false;
    this.emitStatus();
  }

  /**
   * P2P の hello が成立したリンクの有無。WS が切れている間だけ状態に効く
   * (WS が生きている間は P2P の数は参考情報)。
   */
  markP2PAvailable(available: boolean): void {
    const next = available === true;
    if (this.p2pAvailable === next) return;
    this.p2pAvailable = next;
    if (this.transport === "offline") this.serverSaved = false;
    this.emitStatus();
  }

  /** タイマーを止めて、保留中の保存を書き切る。文書は残す (呼び出し側が寿命を決める)。 */
  async disconnect(): Promise<void> {
    this.stopTimers();
    this.peerTransport = null;
    for (const id of [...this.localClaims]) {
      this.callbacks.send({ type: "claim_release", id, sessionId: this.sessionId });
    }
    this.localClaims.clear();
    this.remoteClaims.clear();
    this.previews.clear();
    this.throttles.clear();
    this.publishProjection();
    await this.flush();
  }

  /** 明示的な退出。保存を書き切ってから DB と文書を閉じる。保存済み更新は消さない。 */
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    // 閉じた後に、古い projection で画面を上書きしない (再接続中の別レプリカを守る)
    this.peerTransport = null;
    this.stopTimers();
    this.localClaims.clear();
    this.remoteClaims.clear();
    this.previews.clear();
    this.throttles.clear();
    await this.flush();
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.store.close();
    this.world.destroy();
    if (activeWorld === this) {
      activeWorld = null;
      crdtActive = false;
    }
  }

  flush(): Promise<void> {
    // 保存の途中でスナップショット再試行が積まれることがある。それが終わるまで待つ
    const settle = async (): Promise<void> => {
      let current = this.persistence;
      for (;;) {
        await current;
        if (current === this.persistence) return;
        current = this.persistence;
      }
    };
    return settle();
  }

  private onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === "load") {
      // 保存済みの更新を読み直しただけなので、書き戻しも再送もしない
      this.publishProjection();
      return;
    }
    if (origin === "remote") {
      // サーバーから来た更新もローカルに保存する (オフラインで再読み込みしたときに復元できるように)。
      // ただし、受信元 (サーバー) へも P2P へもエコーしない
      this.persist(update);
      this.publishProjection();
      return;
    }
    const fromPeer = isPeerOrigin(origin) ? origin.peerId : undefined;
    // ローカル編集も P2P 由来の編集も、サーバーが ACK するまでは「サーバー保存済み」ではない
    this.serverSaved = false;
    this.persist(update);
    this.sendToServer(update);
    this.sendToP2P(update, fromPeer);
    this.publishProjection();
  }

  private persist(update: Uint8Array): void {
    this.pendingWrites++;
    this.localSaved = false;
    this.emitStatus();
    void this.enqueue(async () => {
      try {
        await this.store.append(update);
        this.pendingWrites--;
        // 以前の append が失敗していたら、スナップショットで欠けた更新を埋め直す
        if (this.appendDirty) this.scheduleSnapshotRetry();
        if (!this.memoryOnly && !this.saveFailed && this.pendingWrites === 0) this.localSaved = true;
        this.emitStatus();
      } catch (error) {
        this.pendingWrites--;
        this.appendDirty = true;
        this.markSaveFailed(error);
        // append の失敗は、その後の append が成功しても穴が残る。全文スナップショットで回復を試す
        this.scheduleSnapshotRetry();
      }
    });
    this.maybeCompact(update.length);
  }

  /** append の失敗で欠けた更新を、全文スナップショットの compact で埋め直す。 */
  private scheduleSnapshotRetry(): void {
    if (this.snapshotRetryScheduled || this.closed || this.closing) return;
    this.snapshotRetryScheduled = true;
    void this.enqueue(async () => {
      const snapshot = this.world.encodeUpdate();
      await this.store.compact(snapshot, mergeUpdatesForCompaction);
      this.appendDirty = false;
      this.saveFailed = false;
      this.localSaved = true;
      this.updatesSinceCompact = 0;
      this.bytesSinceCompact = snapshot.length;
      this.emitStatus();
    })
      .catch((error: unknown) => {
        // まだ回復していない。saveFailed は維持し、次の append でもう一度試す
        this.warnCompaction(error);
      })
      .finally(() => {
        this.snapshotRetryScheduled = false;
      });
  }

  private maybeCompact(updateBytes: number): void {
    this.updatesSinceCompact++;
    this.bytesSinceCompact += updateBytes;
    if (this.updatesSinceCompact < this.compactEvery && this.bytesSinceCompact <= this.compactBytes) return;
    if (this.deferCompaction) {
      // 壊れた行を読み飛ばした直後は、まだ圧縮しない (残りの行を消さない)
      this.deferCompaction = false;
      this.updatesSinceCompact = 0;
      this.bytesSinceCompact = 0;
      return;
    }
    if (this.compactScheduled) return;
    this.compactScheduled = true;
    void this.enqueue(async () => {
      // 直前までの append が終わった後にスナップショットを作る
      const snapshot = this.world.encodeUpdate();
      await this.store.compact(snapshot, mergeUpdatesForCompaction);
      this.updatesSinceCompact = 0;
      this.bytesSinceCompact = snapshot.length;
      this.appendDirty = false;
      // スナップショットが書けたら、append 失敗による欠けも回復している
      if (this.saveFailed && !this.memoryOnly) {
        this.saveFailed = false;
        this.localSaved = true;
        this.emitStatus();
      }
    }).then(
      () => {
        this.compactScheduled = false;
      },
      (error: unknown) => {
        this.compactScheduled = false;
        // 圧縮の失敗は一時的なものとして扱う。append は残っているので、次の更新で再試行する
        this.warnCompaction(error);
      },
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.persistence.then(operation, operation);
    this.persistence = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** WebSocket (ワールドサーバー) へ更新を送る。大きいものは sync_part に分ける。 */
  private sendToServer(update: Uint8Array): void {
    if (isEmptyUpdate(update)) return;
    const encoded = toBase64(update);
    if (encoded.length <= BASE64_UPDATE_LIMIT) {
      this.callbacks.send({ type: "sync_update", update: encoded });
      return;
    }
    const transferId = `update:${randomId()}`;
    for (const part of encodeTransfer(update, transferId)) {
      this.callbacks.send({ type: "sync_part", ...part });
    }
  }

  /** P2P ピアへ更新を送る。送信元 (exceptPeerId) にはエコーしない。 */
  private sendToP2P(update: Uint8Array, exceptPeerId?: string): void {
    if (isEmptyUpdate(update) || this.peerTransport === null) return;
    this.peerTransport.send(update, exceptPeerId);
  }

  private applyRemote(update: Uint8Array): void {
    if (update.length === 0) return;
    this.world.applyUpdate(update, "remote");
  }

  private markOnline(): void {
    if (this.transport === "offline") return;
    // 正常な同期メッセージが届いたら、回復したものとしてエラー表示を消す
    this.syncError = null;
    this.transport = "online";
    this.emitStatus();
  }

  private publishProjection(): void {
    if (this.closing || this.closed) return;
    const objects: Record<string, WorldObject> = {};
    for (const object of this.world.getObjects()) objects[object.id] = object;

    // リモートで消えたオブジェクトに紐づく、ローカルの一時状態を掃除する。
    // これを残すと、消えた ID への claim を送り続けたり、プレビューが残ったりする。
    const present = new Set(Object.keys(objects));
    for (const id of [...this.previews.keys()]) if (!present.has(id)) this.clearPreview(id);
    for (const id of [...this.throttles.keys()]) if (!present.has(id)) this.clearThrottle(id);
    for (const id of [...this.remoteClaims.keys()]) if (!present.has(id)) this.remoteClaims.delete(id);
    for (const id of [...this.localClaims]) if (!present.has(id)) this.localClaims.delete(id);
    if (this.localClaims.size === 0) this.stopHeartbeat();
    if (this.previews.size === 0 && this.previewTimer !== undefined) {
      clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }

    for (const [id, preview] of this.previews) {
      const object = objects[id];
      if (!object) continue;
      objects[id] = { ...object, position: [...preview.position], yaw: preview.yaw, pitch: preview.pitch, scale: preview.scale };
    }

    const now = this.now();
    this.pruneClaims(now);
    for (const [id, claims] of this.remoteClaims) {
      const object = objects[id];
      if (!object) continue;
      const holder = this.claimHolder(claims);
      if (holder) objects[id] = { ...object, heldBy: holder };
    }
    const self = this.selfId();
    if (self) {
      for (const id of this.localClaims) {
        const object = objects[id];
        if (object) objects[id] = { ...object, heldBy: self };
      }
    }

    this.callbacks.onObjects(objects);
  }

  private claimHolder(claims: Map<string, RemoteClaim>): string | undefined {
    const now = this.now();
    let winner: RemoteClaim | undefined;
    for (const claim of claims.values()) {
      if (claim.until <= now) continue;
      if (winner === undefined) {
        winner = claim;
        continue;
      }
      // 表示上の勝者を決定的に選ぶ (厳密なロックではない)。sessionId が小さい方、
      // 同じ session なら seq が大きい方、seq も同じなら peerId が小さい方を勝者にする。
      // claims は sessionId をキーにしているので、WS と P2P の同じ claim は 1 つにまとまる。
      if (
        claim.sessionId < winner.sessionId ||
        (claim.sessionId === winner.sessionId &&
          (claim.seq > winner.seq || (claim.seq === winner.seq && claim.peerId < winner.peerId)))
      ) {
        winner = claim;
      }
    }
    return winner?.peerId;
  }

  private acceptRemoteClaim(msg: Extract<ServerMessage, { type: "claim" }>): void {
    if (
      typeof msg.id !== "string" ||
      typeof msg.peerId !== "string" ||
      typeof msg.sessionId !== "string" ||
      msg.sessionId.length === 0 ||
      !Number.isFinite(msg.seq) ||
      !Number.isFinite(msg.until)
    ) {
      return;
    }
    // 自分のセッションの claim は、WS / P2P のどちらから戻ってきても無視する
    if (msg.sessionId === this.sessionId) return;
    let claims = this.remoteClaims.get(msg.id);
    // sessionId をキーにする: WS と P2P で同じ claim が二重に届いても 1 つにまとめる
    const key = msg.sessionId;
    const existing = claims?.get(key);
    // 古い claim / release は捨てる
    if (existing && existing.seq > msg.seq) return;
    if (msg.until <= this.now()) {
      // until 0 の claim は release (サーバー・P2P 共通)
      if (!claims || !existing) return;
      claims.delete(key);
      if (claims.size === 0) this.remoteClaims.delete(msg.id);
      this.publishProjection();
      return;
    }
    if (!claims) {
      claims = new Map();
      this.remoteClaims.set(msg.id, claims);
    }
    claims.set(key, { id: msg.id, peerId: msg.peerId, sessionId: msg.sessionId, seq: msg.seq, until: msg.until });
    this.ensurePruneTimer();
    this.publishProjection();
  }

  private ensurePruneTimer(): void {
    if (this.pruneTimer !== undefined) return;
    this.pruneTimer = setInterval(() => {
      const changed = this.pruneClaims(this.now());
      if (changed) this.publishProjection();
      if (this.remoteClaims.size === 0) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
      }
    }, CLAIM_PRUNE_MS);
  }

  /** 期限切れの claim を捨てる。表示の更新は呼び出し側が行う。 */
  private pruneClaims(now: number): boolean {
    let changed = false;
    for (const [id, claims] of this.remoteClaims) {
      for (const [key, claim] of claims) {
        if (claim.until <= now) {
          claims.delete(key);
          changed = true;
        }
      }
      if (claims.size === 0) {
        this.remoteClaims.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  private sendClaim(id: string): void {
    this.claimSeq++;
    this.sendEphemeral({
      type: "claim",
      id,
      sessionId: this.sessionId,
      seq: this.claimSeq,
      until: this.now() + CLAIM_TTL_MS,
    });
  }

  private dropLocalClaim(id: string): void {
    if (!this.localClaims.delete(id)) return;
    this.sendEphemeral({ type: "claim_release", id, sessionId: this.sessionId });
    if (this.localClaims.size === 0) this.stopHeartbeat();
  }

  /** claim は WebSocket と P2P の両方に載せる (WS が切れていても見えている相手には届く)。 */
  private sendEphemeral(msg: ClientMessage): void {
    this.callbacks.send(msg);
    this.peerTransport?.sendEphemeral(msg);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearPreview(id: string): void {
    this.previews.delete(id);
  }

  private clearThrottle(id: string): void {
    const state = this.throttles.get(id);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    this.throttles.delete(id);
  }

  private stopTimers(): void {
    this.stopHeartbeat();
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    if (this.previewTimer !== undefined) {
      clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }
    for (const state of this.throttles.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    this.throttles.clear();
  }

  private markSaveFailed(error?: unknown): void {
    if (!this.saveFailed) {
      this.saveFailed = true;
      this.localSaved = false;
      this.warnStorage(error);
    }
    this.emitStatus();
  }

  private warnStorage(error?: unknown): void {
    if (this.warnedStorage) return;
    this.warnedStorage = true;
    if (error !== undefined) console.warn("[crdt] local save failed:", error);
    this.callbacks.onWarning?.("ローカル保存を利用できません。変更はメモリのみに保持されます");
  }

  /** 圧縮の失敗は一時的な警告。append 済みの更新は残したまま、次の機会に再試行する。 */
  private warnCompaction(error: unknown): void {
    if (!this.warnedCompaction) {
      this.warnedCompaction = true;
      console.warn("[crdt] local compaction failed; will retry later:", error);
    }
  }

  private emitStatus(force = false): void {
    const sync: CrdtSyncStatus = this.syncError !== null
      ? "sync-error"
      : this.saveFailed
        ? "save-failed"
        : this.transport === "offline" && (this.p2pAvailable || this.peerCount > 0)
          ? "p2p"
          : this.transport;
    const status: CrdtStatus = {
      sync,
      localSaved: this.localSaved,
      serverSaved: this.serverSaved,
      peerCount: this.peerCount,
    };
    if (
      !force &&
      this.lastStatus !== undefined &&
      this.lastStatus.sync === status.sync &&
      this.lastStatus.localSaved === status.localSaved &&
      this.lastStatus.serverSaved === status.serverSaved &&
      this.lastStatus.peerCount === status.peerCount
    ) {
      return;
    }
    this.lastStatus = status;
    this.callbacks.onStatus(status);
  }
}

/** welcome の sync 情報から、このブラウザのレプリカを開く。 */
export async function openCrdtWorld(
  info: CrdtSyncInfo,
  selfId: () => string | undefined,
  callbacks: CrdtCallbacks,
  options: CrdtWorldOptions = {},
): Promise<CrdtWorld> {
  const token = ++openToken;
  const store = options.store !== undefined ? options.store : await openUpdateStore(crdtDatabaseName(info));
  const world = new CrdtWorld(info, selfId, callbacks, {
    ...options,
    store: store ?? new MemoryUpdateStore(),
    memoryOnly: options.memoryOnly ?? store === null,
  });
  try {
    await world.init();
  } catch (error) {
    if (token === openToken) crdtActive = false;
    throw error;
  }
  if (token === openToken) {
    activeWorld = world;
    crdtActive = true;
  }
  return world;
}
