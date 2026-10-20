import type { ClientMessage, ServerMessage } from "@proto/protocol";
import { TransferAssembler, encodeTransfer, fromBase64, stateVectorEquals, toBase64 } from "@proto/world-sync";
import type { CrdtPeerTransport, CrdtWorld } from "./crdt";
import {
  WORLD_SYNC_PROTOCOL,
  describeError,
  dialSyncProtocol,
  getLibp2p,
  getServerPeerId,
  type Libp2pNode,
  type Libp2pStream,
} from "./ipfs";

export { WORLD_SYNC_PROTOCOL };

/** 1 フレーム (長さヘッダを除く JSON) の上限。 */
export const MAX_PEER_FRAME_BYTES = 16 * 1024 * 1024;
/** 分割転送の 1 チャンク (base64 前) の上限。 */
const PEER_CHUNK_BYTES = 48 * 1024;
/** 1 つのピアへの送信待ちの上限。超えたら捨てて hello で再同期する。 */
const OUTBOUND_QUEUE_BYTES = 2 * 1024 * 1024;
/** 再構成する文書更新の上限。 */
const PEER_TRANSFER_BYTES = 16 * 1024 * 1024;
const DIAL_INTERVAL_MS = 5_000;
const DIAL_LOG_INTERVAL_MS = 30_000;
const MAX_REMEMBERED_PEERS = 64;
const MAX_LINKS = 64;
const MAX_PENDING_DIALS = 16;

export type PeerFrame =
  | { t: "hello"; worldId: string; schemaVersion: number; vector: string }
  | { t: "init"; update: string }
  | { t: "update"; update: string }
  | { t: "part"; transferId: string; index: number; count: number; data: string }
  | { t: "ack"; vector: string }
  /** peerId は WS 側の ID (あれば)。無ければ受信側が libp2p の ID を使う。 */
  | { t: "claim"; id: string; sessionId: string; seq: number; until: number; peerId?: string }
  | { t: "claim_release"; id: string; sessionId: string }
  | { t: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Yjs は差分が無くても 2 バイト ([0, 0]) を返すことがある。 */
function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length === 0 || (update.length === 2 && update[0] === 0 && update[1] === 0);
}

/** 受信フレームの形を検証する。JSON として正しくても、型が違えば受け付けない。 */
export function isPeerFrame(value: unknown): value is PeerFrame {
  if (!isRecord(value)) return false;
  switch (value["t"]) {
    case "hello":
      return (
        typeof value["worldId"] === "string" &&
        typeof value["schemaVersion"] === "number" &&
        Number.isInteger(value["schemaVersion"]) &&
        typeof value["vector"] === "string"
      );
    case "init":
    case "update":
      return typeof value["update"] === "string";
    case "part":
      return (
        isNonEmptyString(value["transferId"]) &&
        value["transferId"].length <= 256 &&
        typeof value["index"] === "number" &&
        Number.isInteger(value["index"]) &&
        value["index"] >= 0 &&
        typeof value["count"] === "number" &&
        Number.isInteger(value["count"]) &&
        value["count"] >= 1 &&
        typeof value["data"] === "string"
      );
    case "ack":
      return typeof value["vector"] === "string";
    case "claim":
      return (
        isNonEmptyString(value["id"]) &&
        isNonEmptyString(value["sessionId"]) &&
        isFiniteNumber(value["seq"]) &&
        isFiniteNumber(value["until"]) &&
        (value["peerId"] === undefined || isNonEmptyString(value["peerId"]))
      );
    case "claim_release":
      return isNonEmptyString(value["id"]) && isNonEmptyString(value["sessionId"]);
    case "error":
      return typeof value["message"] === "string";
    default:
      return false;
  }
}

/** 1 フレームを、4 バイト big-endian の長さ + UTF-8 JSON にする。 */
export function encodePeerFrame(frame: PeerFrame): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(frame));
  if (payload.length === 0 || payload.length > MAX_PEER_FRAME_BYTES) {
    throw new RangeError(`peer frame too large: ${payload.length}`);
  }
  const output = new Uint8Array(4 + payload.length);
  new DataView(output.buffer, output.byteOffset, 4).setUint32(0, payload.length, false);
  output.set(payload, 4);
  return output;
}

/**
 * 長さヘッダ付きフレームのデコーダ。部分受信・複数フレーム・1 フレームの分割に対応する。
 * 長さが 0 / 上限超え、または JSON が不正なら例外を投げる (呼び出し側がストリームを閉じる)。
 */
export class PeerFrameDecoder {
  private buffer = new Uint8Array(1024);
  private length = 0;
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): PeerFrame[] {
    // 先に、既に揃っているフレームを処理する (未処理分と合わせて上限を誤判定しない)
    const frames = this.drain();
    if (chunk.length > 0) {
      if (this.length + chunk.length > MAX_PEER_FRAME_BYTES + 4) {
        throw new Error("peer frame buffer exceeded the limit");
      }
      this.append(chunk);
      frames.push(...this.drain());
    }
    return frames;
  }

  private append(chunk: Uint8Array): void {
    const needed = this.length + chunk.length;
    if (needed > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < needed) capacity = Math.min(MAX_PEER_FRAME_BYTES + 4, Math.max(needed, capacity * 2));
      const next = new Uint8Array(capacity);
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(chunk, this.length);
    this.length = needed;
  }

  private drain(): PeerFrame[] {
    const frames: PeerFrame[] = [];
    for (;;) {
      if (this.length < 4) break;
      const size = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
      if (size === 0) throw new Error("peer frame length is zero");
      if (size > MAX_PEER_FRAME_BYTES) throw new Error(`peer frame too large: ${size}`);
      if (this.length < 4 + size) break;

      const payload = this.buffer.subarray(4, 4 + size);
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.decoder.decode(payload));
      } catch {
        throw new Error("peer frame is not valid JSON");
      }
      if (!isPeerFrame(parsed)) throw new Error("peer frame has an invalid shape");
      frames.push(parsed);

      const consumed = 4 + size;
      this.buffer.copyWithin(0, consumed, this.length);
      this.length -= consumed;
    }
    if (this.length === 0 && this.buffer.length > 1024) this.buffer = new Uint8Array(1024);
    return frames;
  }
}

// ---- testable session (libp2p に依存しない) ----

export interface PeerHello {
  worldId: string;
  schemaVersion: number;
  vector: string;
}

export interface PeerSessionOptions {
  /** 相手 (このセッションのリモート側) の libp2p ピア ID。claim の peerId に使う。 */
  peerId: string;
  sendFrame(frame: PeerFrame): void;
  /**
   * 分割した大きな更新を送るフック。実装側はキューに余裕ができるまで待てる。
   * 省略時は sendFrame を順に呼ぶ (テスト用)。
   */
  sendFrames?(frames: PeerFrame[]): void;
  applyUpdate(update: Uint8Array): void;
  /** 現在の worldId / schema / state vector。再同期のたびに最新値を返す。 */
  getHello(): PeerHello;
  /** 相手の state vector に足りないローカル更新。 */
  diffFor(vector: Uint8Array): Uint8Array;
  /** 受信した claim / claim_release を world に渡す。 */
  onClaim?(msg: Extract<ServerMessage, { type: "claim" }>): void;
  /** 相手の hello を受け入れた (worldId / schema が一致した)。 */
  onHandshake?(): void;
  onError?(message: string): void;
  /** 致命的な同期エラー (handshake の不一致など) を HUD に伝える。 */
  onSyncError?(message: string): void;
  /** transferId の生成 (テストで固定できる)。 */
  idFactory?(): string;
}

function defaultId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * 1 本の P2P ストリームの上で動く同期セッション。hello / init / ack のやり取りと、
 * 更新の分割・再構成を担当する。フレームの入出力を差し替えられるので、テストでは
 * インメモリの双方向キューで 2 つのセッションをつなげられる。
 */
export class PeerSession {
  private readonly assembler = new TransferAssembler({ maxBytes: PEER_TRANSFER_BYTES });
  /** release に使う、このピアから見た最後の claim seq (id:sessionId ごと)。 */
  private readonly claimSeqs = new Map<string, number>();
  private closed = false;
  /** 有効な hello を受け取ったか。それまでは hello 以外を受け付けない。 */
  private helloReceived = false;
  private negotiatedWorldId: string | null = null;
  private negotiatedSchemaVersion: number | null = null;

  constructor(private readonly options: PeerSessionOptions) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** ストリームを開いた直後に hello を送る。 */
  start(): void {
    this.sendHello();
  }

  /** 送信キューがあふれたときなどに、hello からやり直す。 */
  requestResync(): void {
    this.sendHello();
  }

  sendUpdate(update: Uint8Array, kind: "init" | "update" = "update"): void {
    if (this.closed || isEmptyUpdate(update)) return;
    const encoded = toBase64(update);
    if (encoded.length <= PEER_CHUNK_BYTES) {
      this.emit({ t: kind, update: encoded });
      return;
    }
    const transferId = `p2p:${this.options.idFactory?.() ?? defaultId()}`;
    const frames: PeerFrame[] = encodeTransfer(update, transferId, PEER_CHUNK_BYTES).map((part) => ({
      t: "part" as const,
      ...part,
    }));
    if (this.options.sendFrames !== undefined) {
      try {
        this.options.sendFrames(frames);
      } catch (error) {
        this.fail(describeError(error));
      }
      return;
    }
    for (const frame of frames) {
      if (!this.emit(frame)) return;
    }
  }

  sendClaim(claim: {
    id: string;
    sessionId: string;
    seq: number;
    until: number;
    peerId?: string;
  }): void {
    this.emit({ t: "claim", ...claim });
  }

  sendClaimRelease(id: string, sessionId: string): void {
    this.emit({ t: "claim_release", id, sessionId });
  }

  /**
   * 受信フレームを処理する。壊れたフレーム・base64・大きすぎる転送でも外へ例外を出さない
   * (ストリームを閉じるかどうかは onError / isClosed で判断する)。
   */
  receive(frame: PeerFrame): void {
    if (this.closed) return;
    try {
      if (!isPeerFrame(frame)) {
        this.fail("不正なフレームです");
        return;
      }
      // hello が成立するまでは、hello 以外のフレームを一切適用しない
      if (!this.helloReceived && frame.t !== "hello") {
        this.reject("hello が必要です");
        return;
      }
      switch (frame.t) {
        case "hello":
          this.onHello(frame);
          break;
        case "init":
        case "update":
          this.onDocument(frame.update);
          break;
        case "part":
          this.onPart(frame);
          break;
        case "ack":
          this.onAck(frame.vector);
          break;
        case "claim":
          this.onClaim(frame);
          break;
        case "claim_release":
          this.onClaimRelease(frame);
          break;
        case "error":
          this.reportSyncError(frame.message);
          this.fail(frame.message);
          break;
      }
    } catch (error) {
      this.fail(describeError(error));
    }
  }

  private onHello(frame: Extract<PeerFrame, { t: "hello" }>): void {
    // 2 回目以降の hello は、最初に合意した world / schema から変わっていないことを確認する
    if (
      this.helloReceived &&
      (frame.worldId !== this.negotiatedWorldId || frame.schemaVersion !== this.negotiatedSchemaVersion)
    ) {
      this.reject("handshake 後に worldId / schemaVersion が変わりました");
      return;
    }
    let local: PeerHello;
    try {
      local = this.options.getHello();
    } catch (error) {
      this.fail(describeError(error));
      return;
    }
    if (frame.worldId !== local.worldId) {
      this.reject(`worldId が一致しません (${frame.worldId} != ${local.worldId})`);
      return;
    }
    if (frame.schemaVersion !== local.schemaVersion) {
      this.reject(`schemaVersion が一致しません (${frame.schemaVersion} != ${local.schemaVersion})`);
      return;
    }
    const vector = fromBase64(frame.vector);
    if (vector === null) {
      this.reject("state vector が base64 として不正です");
      return;
    }
    this.helloReceived = true;
    this.negotiatedWorldId = frame.worldId;
    this.negotiatedSchemaVersion = frame.schemaVersion;
    this.options.onHandshake?.();
    try {
      // 既に同じ state vector なら、delete set だけの差分を送らない
      const localVector = fromBase64(local.vector);
      const sameVector = localVector !== null && stateVectorEquals(vector, localVector);
      if (!sameVector) {
        const diff = this.options.diffFor(vector);
        // 差分が無くても init は返す (相手は適用しても何も変わらない)
        if (isEmptyUpdate(diff)) this.emit({ t: "init", update: toBase64(diff) });
        else this.sendUpdate(diff, "init");
      }
    } catch (error) {
      this.options.onError?.(`差分を作れませんでした: ${describeError(error)}`);
    }
    this.sendAck();
  }

  private onDocument(encoded: string): void {
    const update = fromBase64(encoded);
    if (update === null || update.length === 0) return;
    this.options.applyUpdate(update);
  }

  private onPart(frame: Extract<PeerFrame, { t: "part" }>): void {
    // 1 チャンクが上限を超える base64 は、デコードで大きな領域を確保する前に捨てる
    const maxEncoded = Math.ceil(PEER_TRANSFER_BYTES / 3) * 4;
    if (frame.data.length > maxEncoded) {
      this.options.onError?.("転送チャンクが大きすぎます");
      return;
    }
    const update = this.assembler.accept({
      transferId: frame.transferId,
      index: frame.index,
      count: frame.count,
      data: frame.data,
    });
    if (update === null || update.length === 0) return;
    this.options.applyUpdate(update);
  }

  private onAck(vectorBase64: string): void {
    const vector = fromBase64(vectorBase64);
    if (vector === null) return;
    let localVector: Uint8Array | null = null;
    try {
      localVector = fromBase64(this.options.getHello().vector);
    } catch (error) {
      this.options.onError?.(`state vector を読めませんでした: ${describeError(error)}`);
      return;
    }
    // もう同じ state vector なら送るものは無い。delete set だけの差分で ack を往復させない
    if (localVector !== null && stateVectorEquals(vector, localVector)) return;
    let diff: Uint8Array;
    try {
      diff = this.options.diffFor(vector);
    } catch (error) {
      this.options.onError?.(`差分を作れませんでした: ${describeError(error)}`);
      return;
    }
    // ack への応答は差分だけ。ここで ack を返すと無限に往復する
    this.sendUpdate(diff, "update");
  }

  private onClaim(frame: Extract<PeerFrame, { t: "claim" }>): void {
    const key = `${frame.sessionId}\u0000${frame.id}`;
    const previous = this.claimSeqs.get(key) ?? 0;
    if (frame.seq < previous) return;
    this.rememberClaimSeq(key, frame.seq);
    this.options.onClaim?.({
      type: "claim",
      id: frame.id,
      // WS の peerId が分かるならそれを使う (WS と P2P の claim を同じ人として表示する)
      peerId: frame.peerId ?? this.options.peerId,
      sessionId: frame.sessionId,
      seq: frame.seq,
      until: frame.until,
    });
  }

  private onClaimRelease(frame: Extract<PeerFrame, { t: "claim_release" }>): void {
    const key = `${frame.sessionId}\u0000${frame.id}`;
    const seq = (this.claimSeqs.get(key) ?? 0) + 1;
    this.rememberClaimSeq(key, seq);
    // 既存の claim 処理は until 0 を release として扱う
    this.options.onClaim?.({
      type: "claim",
      id: frame.id,
      peerId: this.options.peerId,
      sessionId: frame.sessionId,
      seq,
      until: 0,
    });
  }

  private rememberClaimSeq(key: string, seq: number): void {
    if (this.claimSeqs.size >= 512 && !this.claimSeqs.has(key)) this.claimSeqs.clear();
    this.claimSeqs.set(key, seq);
  }

  private sendHello(): void {
    if (this.closed) return;
    let hello: PeerHello;
    try {
      hello = this.options.getHello();
    } catch (error) {
      this.fail(describeError(error));
      return;
    }
    this.emit({
      t: "hello",
      worldId: hello.worldId,
      schemaVersion: hello.schemaVersion,
      vector: hello.vector,
    });
  }

  private sendAck(): void {
    if (this.closed) return;
    try {
      this.emit({ t: "ack", vector: this.options.getHello().vector });
    } catch (error) {
      this.fail(describeError(error));
    }
  }

  private emit(frame: PeerFrame): boolean {
    if (this.closed) return false;
    try {
      this.options.sendFrame(frame);
      return true;
    } catch (error) {
      this.fail(describeError(error));
      return false;
    }
  }

  /** プロトコル違反: 相手に error を返してから、このリンクを閉じる。 */
  private reject(message: string): void {
    if (this.closed) return;
    this.emit({ t: "error", message });
    this.reportSyncError(message);
    this.fail(message);
  }

  private reportSyncError(message: string): void {
    try {
      this.options.onSyncError?.(message);
    } catch {
      // 通知側の失敗でセッションを壊さない
    }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.options.onError?.(message);
    } catch {
      // ログ側の失敗でセッションを壊さない
    }
  }
}

// ---- libp2p adapter ----

/** 上限付きの非同期 FIFO。あふれたら中身を捨てて onOverflow を呼ぶ。 */
class OutboundQueue {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private closed = false;
  private waiters: (() => void)[] = [];
  private spaceWaiters: (() => void)[] = [];
  onOverflow: (() => void) | null = null;

  constructor(private readonly maxBytes: number) {}

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  get byteLength(): number {
    return this.bytes;
  }

  push(bytes: Uint8Array): void {
    if (this.closed) return;
    if (this.bytes + bytes.length > this.maxBytes) {
      this.chunks = [];
      this.bytes = 0;
      this.notifySpace();
      this.onOverflow?.();
      return;
    }
    this.chunks.push(bytes);
    this.bytes += bytes.length;
    this.signal();
  }

  shift(): Uint8Array | undefined {
    const chunk = this.chunks.shift();
    if (chunk === undefined) return undefined;
    this.bytes -= chunk.length;
    this.notifySpace();
    return chunk;
  }

  /** 書き込み側が待つ。データ・close・drain 要求のどれかで目を覚ます。 */
  wait(): Promise<void> {
    if (this.closed || this.chunks.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** 大きな転送の生産側が、キューの空きを待つ。 */
  async waitForSpace(limit: number): Promise<void> {
    while (!this.closed && this.bytes >= limit) {
      await new Promise<void>((resolve) => this.spaceWaiters.push(resolve));
    }
  }

  /** 書き込み側に「drain 待ちが発生した」ことを伝える。 */
  signal(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  close(): void {
    this.closed = true;
    this.chunks = [];
    this.bytes = 0;
    this.signal();
    this.notifySpace();
  }

  private notifySpace(): void {
    const waiters = this.spaceWaiters;
    this.spaceWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

interface PeerLink {
  readonly peerId: string;
  readonly stream: Libp2pStream;
  readonly queue: OutboundQueue;
  readonly decoder: PeerFrameDecoder;
  readonly session: PeerSession;
  helloOk: boolean;
  closed: boolean;
  /** ストリームの送信バッファが一杯で、drain を待つ必要がある。 */
  needsDrain: boolean;
  resyncTimer?: ReturnType<typeof setTimeout>;
}

export interface P2POptions {
  getWorld: () => CrdtWorld | null;
  log?: (m: string) => void;
}

let p2pOptions: P2POptions | null = null;
let started = false;
let stopping = false;
/** 非同期の start が、退出・再開始の後に完了しても状態を書き換えないための世代。 */
let generation = 0;
let libp2p: Libp2pNode | null = null;
let handlerRegistered = false;
let dialTimer: ReturnType<typeof setInterval> | undefined;
let boundWorld: CrdtWorld | null = null;
let onConnectionOpen: ((event: { detail: { remotePeer: { toString(): string } } }) => void) | null = null;

const remembered = new Set<string>();
const links = new Map<string, PeerLink>();
const pendingDials = new Set<string>();
const lastDialLog = new Map<string, number>();

function log(message: string): void {
  p2pOptions?.log?.(message);
}

function currentWorld(): CrdtWorld | null {
  const world = p2pOptions?.getWorld() ?? null;
  if (world !== boundWorld) {
    boundWorld?.setPeerTransport(null);
    boundWorld = world;
    world?.setPeerTransport(peerTransport);
  }
  return world;
}

const peerTransport: CrdtPeerTransport = {
  send(update, exceptPeerId) {
    for (const link of links.values()) {
      if (link.closed || !link.helloOk || link.peerId === exceptPeerId) continue;
      link.session.sendUpdate(update);
    }
  },
  sendEphemeral(msg: ClientMessage) {
    if (msg.type === "claim") {
      // WS 側の peerId を載せる (未入室なら受信側が libp2p の ID にフォールバックする)
      const wsPeerId = currentWorld()?.selfPeerId();
      for (const link of links.values()) {
        if (link.closed || !link.helloOk) continue;
        link.session.sendClaim({
          id: msg.id,
          sessionId: msg.sessionId,
          seq: msg.seq,
          until: msg.until,
          ...(wsPeerId ? { peerId: wsPeerId } : {}),
        });
      }
    } else if (msg.type === "claim_release") {
      for (const link of links.values()) {
        if (link.closed || !link.helloOk) continue;
        link.session.sendClaimRelease(msg.id, msg.sessionId);
      }
    }
  },
};

/** 有効な hello が成立しているリンクの数。 */
export function p2pPeerCount(): number {
  let count = 0;
  for (const link of links.values()) if (!link.closed && link.helloOk) count++;
  return count;
}

function updateStatus(): void {
  const count = p2pPeerCount();
  const world = currentWorld();
  world?.setPeerCount(count);
  world?.markP2PAvailable(count > 0);
}

function abortStream(stream: Libp2pStream, reason: string): void {
  try {
    stream.abort(new Error(reason));
  } catch {
    // 既に閉じている
  }
}

function closeLink(link: PeerLink, reason: string): void {
  if (link.closed) return;
  link.closed = true;
  if (link.resyncTimer !== undefined) {
    clearTimeout(link.resyncTimer);
    link.resyncTimer = undefined;
  }
  link.queue.close();
  abortStream(link.stream, reason);
  if (links.get(link.peerId) === link) links.delete(link.peerId);
  updateStatus();
}

async function readLoop(link: PeerLink): Promise<void> {
  try {
    for await (const chunk of link.stream) {
      if (link.closed) return;
      const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
      for (const frame of link.decoder.push(bytes)) link.session.receive(frame);
      if (link.session.isClosed) {
        closeLink(link, "session closed");
        return;
      }
    }
  } catch (error) {
    if (!link.closed) log(`peer ${short(link.peerId)} read failed: ${describeError(error)}`);
    closeLink(link, "read failed");
    return;
  }
  closeLink(link, "stream ended");
}

async function writeLoop(link: PeerLink): Promise<void> {
  try {
    while (!link.closed) {
      if (link.needsDrain) {
        await link.stream.onDrain();
        link.needsDrain = false;
        continue;
      }
      const bytes = link.queue.shift();
      if (bytes !== undefined) {
        if (!link.stream.send(bytes)) link.needsDrain = true;
        continue;
      }
      await link.queue.wait();
    }
  } catch (error) {
    if (!link.closed) log(`peer ${short(link.peerId)} write failed: ${describeError(error)}`);
    closeLink(link, "write failed");
  }
}

/**
 * フレームを送る。書き込み側が空いていれば直接 stream へ渡し、詰まっていればキューに積む。
 * 大量の分割フレームは enqueueFrames が空きを待ちながら積むので、2 MiB の上限で
 * 正当な転送が落ちない。
 */
function sendFrameBytes(link: PeerLink, bytes: Uint8Array): void {
  if (link.closed) return;
  if (!link.needsDrain && link.queue.isEmpty) {
    try {
      if (link.stream.send(bytes)) return;
      link.needsDrain = true;
      link.queue.signal();
      return;
    } catch (error) {
      log(`peer ${short(link.peerId)} send failed: ${describeError(error)}`);
      closeLink(link, "send failed");
      return;
    }
  }
  link.queue.push(bytes);
}

function enqueueFrames(link: PeerLink, frames: PeerFrame[]): void {
  void (async () => {
    for (const frame of frames) {
      if (link.closed) return;
      let bytes: Uint8Array;
      try {
        bytes = encodePeerFrame(frame);
      } catch (error) {
        log(`peer ${short(link.peerId)} frame too large: ${describeError(error)}`);
        closeLink(link, "frame too large");
        return;
      }
      // 小さな制御フレーム用に少し余白を残す
      const reserve = Math.max(0, Math.floor(OUTBOUND_QUEUE_BYTES * 0.9) - bytes.length);
      await link.queue.waitForSpace(reserve);
      sendFrameBytes(link, bytes);
    }
  })().catch((error: unknown) => {
    log(`peer ${short(link.peerId)} enqueue failed: ${describeError(error)}`);
    closeLink(link, "enqueue failed");
  });
}

function short(peerId: string): string {
  return peerId.length > 10 ? `${peerId.slice(0, 6)}…${peerId.slice(-4)}` : peerId;
}

function adoptStream(peerId: string, stream: Libp2pStream, direction: "inbound" | "outbound"): void {
  if (!started || stopping) {
    abortStream(stream, "stopped");
    return;
  }
  const world = currentWorld();
  if (!world) {
    abortStream(stream, "no world");
    return;
  }

  const existing = links.get(peerId);
  if (existing && !existing.closed) {
    // 両側から同時に dial した場合の重複。小さいピア ID 側は outbound、大きい側は inbound を優先する
    const localId = libp2p?.peerId.toString() ?? "";
    const localLower = localId.length > 0 && localId < peerId;
    const preferNew = direction === "inbound" ? !localLower : localLower;
    if (!preferNew) {
      abortStream(stream, "duplicate link");
      return;
    }
    closeLink(existing, "replaced by duplicate link");
  }
  if (links.size >= MAX_LINKS) {
    abortStream(stream, "too many links");
    return;
  }

  const queue = new OutboundQueue(OUTBOUND_QUEUE_BYTES);
  const session = new PeerSession({
    peerId,
    sendFrame: (frame) => sendFrameBytes(link, encodePeerFrame(frame)),
    sendFrames: (frames) => enqueueFrames(link, frames),
    applyUpdate: (update) => currentWorld()?.applyPeerUpdate(update, peerId),
    getHello: () => {
      const active = currentWorld();
      if (!active) throw new Error("CRDT world is not open");
      return {
        worldId: active.info.worldId,
        schemaVersion: active.info.schemaVersion,
        vector: active.getStateVectorBase64(),
      };
    },
    diffFor: (vector) => {
      const active = currentWorld();
      if (!active) throw new Error("CRDT world is not open");
      return active.encodeLocalDiffForRemote(vector);
    },
    onClaim: (msg) => currentWorld()?.handleServerMessage(msg),
    onHandshake: () => {
      if (link.closed || link.helloOk) return;
      link.helloOk = true;
      updateStatus();
    },
    onError: (message) => log(`peer ${short(peerId)}: ${message}`),
    onSyncError: (message) => {
      log(`peer ${short(peerId)} sync error: ${message}`);
      currentWorld()?.reportSyncError(message);
    },
  });

  const link: PeerLink = {
    peerId,
    stream,
    queue,
    decoder: new PeerFrameDecoder(),
    session,
    helloOk: false,
    closed: false,
    needsDrain: false,
  };
  queue.onOverflow = () => {
    if (link.closed || link.resyncTimer !== undefined) return;
    log(`peer ${short(peerId)} send queue overflow; resyncing`);
    link.resyncTimer = setTimeout(() => {
      link.resyncTimer = undefined;
      if (!link.closed) session.requestResync();
    }, 1000);
  };

  links.set(peerId, link);
  void readLoop(link);
  void writeLoop(link);
  session.start();
  updateStatus();
}

function isServerPeer(peerId: string): boolean {
  return getServerPeerId() === peerId;
}

function noteDialFailure(peerId: string, error: unknown): void {
  const now = Date.now();
  const previous = lastDialLog.get(peerId) ?? 0;
  if (now - previous >= DIAL_LOG_INTERVAL_MS) {
    lastDialLog.set(peerId, now);
    log(`dial ${short(peerId)} failed: ${describeError(error)}`);
  }
}

function ensurePeer(peerId: string): void {
  if (!started || stopping || !remembered.has(peerId) || peerId.length === 0) return;
  if (isServerPeer(peerId)) return;
  if (links.has(peerId) || pendingDials.has(peerId)) return;
  if (pendingDials.size >= MAX_PENDING_DIALS) return;
  pendingDials.add(peerId);
  void dialSyncProtocol(peerId)
    .then((stream) => {
      pendingDials.delete(peerId);
      if (!started || stopping || !remembered.has(peerId)) {
        abortStream(stream, "forgotten");
        return;
      }
      adoptStream(peerId, stream, "outbound");
    })
    .catch((error: unknown) => {
      pendingDials.delete(peerId);
      noteDialFailure(peerId, error);
    });
}

/** 同期相手として覚える (welcome / peer_ipfs)。IPFS のピア ID を安定したキーにする。 */
export function rememberSyncPeer(ipfsPeerId: string): void {
  if (typeof ipfsPeerId !== "string" || ipfsPeerId.length === 0) return;
  if (remembered.size >= MAX_REMEMBERED_PEERS && !remembered.has(ipfsPeerId)) {
    log(`too many remembered peers; ignoring ${short(ipfsPeerId)}`);
    return;
  }
  remembered.add(ipfsPeerId);
  lastDialLog.delete(ipfsPeerId);
  if (started) ensurePeer(ipfsPeerId);
}

/** 明示的な退出・接続断で、この相手との P2P リンクを閉じる。 */
export function forgetSyncPeer(ipfsPeerId: string): void {
  remembered.delete(ipfsPeerId);
  lastDialLog.delete(ipfsPeerId);
  const link = links.get(ipfsPeerId);
  if (link) closeLink(link, "forgotten");
}

/**
 * ワールド同期の P2P transport を開始する。Helia / libp2p が起動していなければ
 * 何もせず戻る (WS だけのモード)。ハンドラの登録は 1 回だけ。
 */
export async function startWorldSyncP2P(options: P2POptions): Promise<void> {
  if (started) return;
  const token = ++generation;
  p2pOptions = options;
  const world = currentWorld();
  if (!world) {
    log("CRDT world is not open; P2P sync not started");
    if (token === generation) p2pOptions = null;
    return;
  }

  let node: Libp2pNode;
  try {
    node = await getLibp2p();
  } catch (error) {
    log(`libp2p is not ready; P2P sync disabled: ${describeError(error)}`);
    if (token === generation) p2pOptions = null;
    return;
  }
  if (token !== generation) return;

  try {
    await node.handle(
      WORLD_SYNC_PROTOCOL,
      (stream, connection) => {
        try {
          const peerId = connection.remotePeer.toString();
          if (isServerPeer(peerId)) {
            abortStream(stream, "server is not a P2P sync peer");
            return;
          }
          adoptStream(peerId, stream, "inbound");
        } catch (error) {
          log(`inbound stream failed: ${describeError(error)}`);
          abortStream(stream, "inbound failed");
        }
      },
      { runOnLimitedConnection: true, maxInboundStreams: 8, maxOutboundStreams: 8 },
    );
  } catch (error) {
    log(`could not register ${WORLD_SYNC_PROTOCOL}: ${describeError(error)}`);
    if (token === generation) p2pOptions = null;
    return;
  }
  if (token !== generation) {
    // 登録の途中で退出・再開始された
    try {
      void node.unhandle(WORLD_SYNC_PROTOCOL);
    } catch {
      // 何もしない
    }
    return;
  }

  started = true;
  stopping = false;
  libp2p = node;
  handlerRegistered = true;

  // 既存の WebRTC / circuit relay 接続が開いたら、そのピアとのストリームを開く
  onConnectionOpen = (event) => {
    try {
      const peerId = event.detail.remotePeer.toString();
      if (peerId === node.peerId.toString() || isServerPeer(peerId)) return;
      if (remembered.has(peerId)) ensurePeer(peerId);
    } catch (error) {
      log(`connection:open handler failed: ${describeError(error)}`);
    }
  };
  try {
    node.addEventListener("connection:open", onConnectionOpen);
  } catch (error) {
    log(`could not watch libp2p connections: ${describeError(error)}`);
  }

  // 覚えているピアで、まだリンクが無いものへ定期的に再接続する (嵐にならない間隔)
  dialTimer = setInterval(() => {
    if (!started || stopping) return;
    for (const peerId of [...remembered]) {
      if (links.size >= MAX_LINKS || pendingDials.size >= MAX_PENDING_DIALS) break;
      if (!links.has(peerId)) ensurePeer(peerId);
    }
  }, DIAL_INTERVAL_MS);

  updateStatus();
  for (const peerId of remembered) ensurePeer(peerId);
  log(`P2P world sync listening on ${WORLD_SYNC_PROTOCOL}`);
}

/**
 * P2P transport を止める。Helia / libp2p 自体は止めない (再接続で再利用する)。
 * 明示的な退出と、ワールドの切り替えで呼ぶ。
 */
export function stopWorldSyncP2P(): void {
  generation++;
  started = false;
  stopping = true;

  if (dialTimer !== undefined) {
    clearInterval(dialTimer);
    dialTimer = undefined;
  }
  if (libp2p !== null && onConnectionOpen !== null) {
    try {
      libp2p.removeEventListener("connection:open", onConnectionOpen);
    } catch {
      // 既に外れている
    }
  }
  onConnectionOpen = null;

  for (const link of [...links.values()]) closeLink(link, "stopped");
  links.clear();
  pendingDials.clear();
  lastDialLog.clear();
  remembered.clear();

  const node = libp2p;
  libp2p = null;
  if (handlerRegistered && node !== null) {
    handlerRegistered = false;
    try {
      void Promise.resolve(node.unhandle(WORLD_SYNC_PROTOCOL)).catch((error: unknown) => {
        console.warn(`[crdt-p2p] unhandle failed: ${describeError(error)}`);
      });
    } catch (error) {
      console.warn(`[crdt-p2p] unhandle failed: ${describeError(error)}`);
    }
  }

  boundWorld?.setPeerTransport(null);
  boundWorld?.setPeerCount(0);
  boundWorld?.markP2PAvailable(false);
  boundWorld = null;
  p2pOptions = null;
  stopping = false;
}
