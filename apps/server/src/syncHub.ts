import type { ClientMessage, ServerMessage, SyncPart } from "@proto/protocol";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHUNK_BYTES,
  TransferAssembler,
  encodeTransfer,
  fromBase64,
  toBase64,
} from "@proto/world-sync";
import type { WebSocket } from "ws";
import type { WorldStore } from "./worldStore.js";

/** crdt-v1 の WebSocket フレームの上限 (チャンクは 48 KiB なので、実際にはもっと小さい)。 */
export const CRDT_MAX_MESSAGE_BYTES = 1024 * 1024;
/** base64 の state vector / update として受け付ける文字列の上限。 */
export const MAX_SYNC_ENCODED_LENGTH = 16 * 1024 * 1024;
/** つかみ claim の期限として許す、現在時刻からの最大の先読み (ms)。 */
export const MAX_CLAIM_AHEAD_MS = 10_000;
const RESYNC_INTERVAL_MS = 10_000;

interface Peer {
  readonly ws: WebSocket;
  readonly peerId: string;
  ready: boolean;
  readonly assembler: TransferAssembler;
  videoErrorSent: boolean;
}

export interface SyncHubOptions {
  log?: (message: string) => void;
}

/**
 * crdt-v1 の WebSocket 同期。world の更新を、接続ごとの state vector に合わせて配る。
 *
 * - サーバー文書の変更は、origin が接続でなければ全員へ、接続ならその接続以外へ配る
 * - 受信した更新は origin = その接続として Yjs に適用し、保存が確定してから ACK を返す
 * - 大きい更新は 48 KiB ずつ sync_part に分ける
 */
export class SyncHub {
  private readonly peers = new Map<WebSocket, Peer>();
  /** セッションごとの最後の claim seq (release を、より新しい seq で送るため)。 */
  private readonly claimSeqs = new Map<string, number>();
  private readonly log: (message: string) => void;
  private readonly unsubscribe: () => void;
  private readonly timer: NodeJS.Timeout;
  private transferSeq = 0;
  private updateCount = 0;
  private closed = false;

  constructor(
    private readonly store: WorldStore,
    options: SyncHubOptions = {},
  ) {
    this.log = options.log ?? ((message) => console.log(`[sync] ${message}`));
    this.unsubscribe = store.world.onUpdate((update, origin) => this.onWorldUpdate(update, origin));
    this.timer = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (peer.ready) this.sendAck(peer.ws);
      }
    }, RESYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  attach(ws: WebSocket, peerId: string): void {
    this.peers.set(ws, {
      ws,
      peerId,
      ready: false,
      assembler: new TransferAssembler({ maxBytes: DEFAULT_MAX_BYTES }),
      videoErrorSent: false,
    });
  }

  detach(ws: WebSocket): void {
    const peer = this.peers.get(ws);
    if (peer) {
      const prefix = `${peer.peerId}:`;
      for (const key of this.claimSeqs.keys()) {
        if (key.startsWith(prefix)) this.claimSeqs.delete(key);
      }
    }
    this.peers.delete(ws);
  }

  isReady(ws: WebSocket): boolean {
    return this.peers.get(ws)?.ready === true;
  }

  peerIdOf(ws: WebSocket): string | undefined {
    return this.peers.get(ws)?.peerId;
  }

  /** 同期以外のメッセージを処理したら true を返す。 */
  handleMessage(ws: WebSocket, msg: ClientMessage): boolean {
    switch (msg.type) {
      case "sync_hello":
        this.onHello(ws, msg);
        return true;
      case "sync_update":
        this.onUpdate(ws, msg.update);
        return true;
      case "sync_part":
        this.onPart(ws, msg);
        return true;
      case "claim":
        this.onClaim(ws, msg);
        return true;
      case "claim_release":
        this.onClaimRelease(ws, msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * 旧来のオブジェクト操作を受け付けてよい接続か。だめなら sync_error を送って false。
   * crdt-v1 では hello が終わるまで、どのクライアントも文書を書き換えられない。
   */
  requireReady(ws: WebSocket): boolean {
    if (this.isReady(ws)) return true;
    this.sendSyncError(ws, "crdt-v1 では sync_hello の完了後に操作してください");
    return false;
  }

  /** 動画同期は crdt-v1 では未対応。接続ごとに 1 回だけ知らせる。 */
  rejectVideo(ws: WebSocket): void {
    const peer = this.peers.get(ws);
    if (!peer || peer.videoErrorSent) return;
    peer.videoErrorSent = true;
    this.sendSyncError(ws, "crdt-v1 では動画同期は未対応です");
  }

  /** JSON として解釈できなかったメッセージが同期系なら、診断できる sync_error を返す。 */
  reportMalformed(ws: WebSocket, text: string): void {
    let type: unknown;
    try {
      type = (JSON.parse(text) as { type?: unknown }).type;
    } catch {
      return;
    }
    if (typeof type !== "string") return;
    if (type.startsWith("sync_") || type === "claim" || type === "claim_release") {
      this.sendSyncError(ws, `不正な ${type} メッセージです`);
    }
  }

  sendSyncError(ws: WebSocket, message: string): void {
    this.send(ws, { type: "sync_error", message });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.peers.clear();
  }

  private onHello(ws: WebSocket, msg: Extract<ClientMessage, { type: "sync_hello" }>): void {
    const peer = this.peers.get(ws);
    if (!peer) {
      this.sendSyncError(ws, "join してから sync_hello を送ってください");
      return;
    }
    peer.ready = false;
    if (msg.worldId !== this.store.worldId) {
      this.sendSyncError(ws, `worldId が一致しません (server: ${this.store.worldId})`);
      return;
    }
    if (msg.schemaVersion !== this.store.syncInfo.schemaVersion) {
      this.sendSyncError(
        ws,
        `schemaVersion が一致しません (server: ${this.store.syncInfo.schemaVersion})`,
      );
      return;
    }
    const vector = fromBase64(msg.stateVector);
    if (vector === null) {
      this.sendSyncError(ws, "stateVector が base64 として不正です");
      return;
    }
    let diff: Uint8Array;
    try {
      // 空の state vector は「何も持っていない」と解釈する (Yjs の state vector は最低 1 バイト)
      diff = vector.length === 0 ? this.store.world.encodeUpdate() : this.store.world.encodeUpdate(vector);
    } catch {
      this.sendSyncError(ws, "stateVector を解釈できません");
      return;
    }
    this.sendDocument(peer, "init", diff);
    peer.ready = true;
    this.sendAck(ws);
  }

  private onUpdate(ws: WebSocket, encoded: string): void {
    const peer = this.peers.get(ws);
    if (!peer) {
      this.sendSyncError(ws, "join してから sync_update を送ってください");
      return;
    }
    if (!peer.ready) {
      this.requireReady(ws);
      return;
    }
    if (encoded.length > MAX_SYNC_ENCODED_LENGTH) {
      this.sendSyncError(ws, "更新が大きすぎます");
      return;
    }
    const update = fromBase64(encoded);
    if (update === null) {
      this.sendSyncError(ws, "update が base64 として不正です");
      return;
    }
    this.applyFromPeer(peer, update);
  }

  private onPart(ws: WebSocket, part: SyncPart & { type: "sync_part" }): void {
    const peer = this.peers.get(ws);
    if (!peer) {
      this.sendSyncError(ws, "join してから sync_part を送ってください");
      return;
    }
    if (!peer.ready) {
      this.requireReady(ws);
      return;
    }
    if (
      typeof part.transferId !== "string" ||
      part.transferId.length === 0 ||
      part.transferId.length > 256 ||
      !Number.isInteger(part.index) ||
      part.index < 0 ||
      !Number.isInteger(part.count) ||
      part.count < 1 ||
      part.count > 4096 ||
      part.index >= part.count ||
      typeof part.data !== "string" ||
      part.data.length > 1024 * 1024
    ) {
      this.sendSyncError(ws, "sync_part が不正です");
      return;
    }
    if (fromBase64(part.data) === null) {
      this.sendSyncError(ws, "sync_part の data が base64 として不正です");
      return;
    }
    const update = peer.assembler.accept(part);
    if (update === null) return; // まだ揃っていない (不正な片は assemble 側で捨てられる)
    this.applyFromPeer(peer, update);
  }

  private applyFromPeer(peer: Peer, update: Uint8Array): void {
    if (update.length === 0) {
      // 空の更新は何も変えない。Yjs に渡すと不正な更新になるので、保存を待って ACK だけ返す
      void this.store
        .scheduleSave()
        .then(() => this.sendAck(peer.ws))
        .catch((err: unknown) => this.sendSyncError(peer.ws, `保存できませんでした: ${String(err)}`));
      return;
    }
    const before = this.updateCount;
    try {
      this.store.world.applyUpdate(update, peer.ws);
    } catch (err) {
      this.log(`failed to apply an update from ${peer.peerId}: ${String(err)}`);
      this.sendSyncError(peer.ws, "更新を適用できませんでした");
      return;
    }
    // 同じ更新の再送などで Yjs が変更を出さない場合も、保存を待って ACK を返す
    if (this.updateCount === before) {
      void this.store
        .scheduleSave()
        .then(() => this.sendAck(peer.ws))
        .catch((err: unknown) => this.sendSyncError(peer.ws, `保存できませんでした: ${String(err)}`));
    }
  }

  private onClaim(ws: WebSocket, msg: Extract<ClientMessage, { type: "claim" }>): void {
    const peer = this.peers.get(ws);
    if (!peer) return;
    if (!this.requireReady(ws)) return;
    if (msg.until > Date.now() + MAX_CLAIM_AHEAD_MS) {
      this.sendSyncError(ws, "claim の期限が長すぎます");
      return;
    }
    this.claimSeqs.set(`${peer.peerId}:${msg.id}:${msg.sessionId}`, msg.seq);
    this.broadcast(
      { type: "claim", id: msg.id, peerId: peer.peerId, sessionId: msg.sessionId, seq: msg.seq, until: msg.until },
      ws,
    );
  }

  private onClaimRelease(ws: WebSocket, msg: Extract<ClientMessage, { type: "claim_release" }>): void {
    const peer = this.peers.get(ws);
    if (!peer) return;
    if (!this.requireReady(ws)) return;
    const key = `${peer.peerId}:${msg.id}:${msg.sessionId}`;
    const seq = (this.claimSeqs.get(key) ?? 0) + 1;
    this.claimSeqs.set(key, seq);
    this.broadcast({ type: "claim", id: msg.id, peerId: peer.peerId, sessionId: msg.sessionId, seq, until: 0 }, ws);
  }

  private onWorldUpdate(update: Uint8Array, origin: unknown): void {
    this.updateCount++;
    const source = origin instanceof Object ? this.peers.get(origin as WebSocket) : undefined;
    if (source) {
      for (const peer of this.peers.values()) {
        if (peer.ws === source.ws || !peer.ready) continue;
        this.sendDocument(peer, "update", update);
      }
      // 受信した側には、保存が確定してから ACK を返す
      void this.store
        .scheduleSave()
        .then(() => this.sendAck(source.ws))
        .catch((err: unknown) => this.sendSyncError(source.ws, `保存できませんでした: ${String(err)}`));
      return;
    }

    for (const peer of this.peers.values()) {
      if (peer.ready) this.sendDocument(peer, "update", update);
    }
    void this.store.scheduleSave().catch((err: unknown) => {
      this.log(`save failed: ${String(err)}`);
    });
  }

  private sendDocument(peer: Peer, kind: "init" | "update", update: Uint8Array): void {
    const encoded = toBase64(update);
    if (encoded.length <= DEFAULT_MAX_CHUNK_BYTES) {
      this.send(
        peer.ws,
        kind === "init" ? { type: "sync_init", update: encoded } : { type: "sync_update", update: encoded },
      );
      return;
    }
    this.transferSeq++;
    const transferId = `${kind}:${peer.peerId}:${this.transferSeq}`;
    for (const part of encodeTransfer(update, transferId, DEFAULT_MAX_CHUNK_BYTES)) {
      this.send(peer.ws, { type: "sync_part", ...part });
    }
  }

  private sendAck(ws: WebSocket): void {
    this.send(ws, { type: "sync_ack", stateVector: toBase64(this.store.world.encodeStateVector()) });
  }

  private broadcast(msg: ServerMessage, except: WebSocket): void {
    for (const peer of this.peers.values()) {
      if (peer.ws === except || !peer.ready) continue;
      this.send(peer.ws, msg);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log(`send failed: ${String(err)}`);
    }
  }
}
