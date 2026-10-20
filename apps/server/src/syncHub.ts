import type { ClientMessage, ServerMessage, SyncPart } from "@proto/protocol";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHUNK_BYTES,
  TransferAssembler,
  WorldDoc,
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
/** 1 回の sync_update / 組み立て後の転送として受け付ける更新のバイト数上限。 */
export const MAX_SYNC_UPDATE_BYTES = 8 * 1024 * 1024;
/** 1 回の更新に含めてよい Yjs の struct 数の上限 (巨大な文書の merge を防ぐ)。 */
export const MAX_SYNC_UPDATE_STRUCTS = 10_000;
/** 文書に存在してよいオブジェクト数の上限 (配置の MAX_OBJECTS とは別の、merge 用の最終防衛線)。 */
export const MAX_WORLD_OBJECTS = 1_000;
/** つかみ claim の期限として許す、現在時刻からの最大の先読み (ms)。 */
export const MAX_CLAIM_AHEAD_MS = 10_000;
/** ピアごとに保持する claim の seq の上限。 */
export const MAX_CLAIM_SEQS_PER_PEER = 256;
/** claim_release の seq を、後続の release と比べられるように保持する時間 (ms)。 */
export const CLAIM_RELEASE_RETENTION_MS = 60_000;
const RESYNC_INTERVAL_MS = 10_000;

interface Peer {
  readonly ws: WebSocket;
  readonly peerId: string;
  ready: boolean;
  readonly assembler: TransferAssembler;
  videoErrorSent: boolean;
  /** 上限を超えた更新を送ってきたピア。以後の更新は適用も ACK もしない。 */
  blocked: boolean;
}

interface ClaimSeq {
  seq: number;
  /** これ以降は不要 (cleanup の対象)。 */
  expiresAt: number;
}

export interface SyncHubOptions {
  log?: (message: string) => void;
}

/**
 * 更新に含まれる Yjs の struct 数を数える (適用前の上限判定用)。
 * 専用の文書に適用して数えるので、壊れた更新なら例外になる。
 */
export function countUpdateStructs(update: Uint8Array): number {
  const probe = new WorldDoc({ actorId: "server:sync-limit-probe" });
  try {
    probe.applyUpdate(update);
    const clients = (
      probe.doc as unknown as { store?: { clients?: Map<number, unknown[]> } }
    ).store?.clients;
    if (!clients) return 0;
    let total = 0;
    for (const structs of clients.values()) total += structs.length;
    return total;
  } finally {
    probe.destroy();
  }
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
  private readonly claimSeqs = new Map<string, ClaimSeq>();
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
      blocked: false,
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
    if (peer.blocked) {
      this.sendSyncError(ws, "この接続は更新の上限を超えたため、同期できません");
      return;
    }
    peer.ready = false;
    if (msg.worldId !== this.store.worldId) {
      this.rejectHello(peer, `worldId が一致しません (server: ${this.store.worldId})`);
      return;
    }
    if (msg.schemaVersion !== this.store.syncInfo.schemaVersion) {
      this.rejectHello(peer, `schemaVersion が一致しません (server: ${this.store.syncInfo.schemaVersion})`);
      return;
    }
    const vector = fromBase64(msg.stateVector);
    if (vector === null) {
      this.rejectHello(peer, "stateVector が base64 として不正です");
      return;
    }
    let diff: Uint8Array;
    try {
      // 空の state vector は「何も持っていない」と解釈する (Yjs の state vector は最低 1 バイト)
      diff = vector.length === 0 ? this.store.world.encodeUpdate() : this.store.world.encodeUpdate(vector);
    } catch {
      this.rejectHello(peer, "stateVector を解釈できません");
      return;
    }
    this.sendDocument(peer, "init", diff);
    peer.ready = true;
    this.sendAck(ws);
  }

  /**
   * sync_hello の検証に失敗したら、sync_error を送って接続を閉じる。
   * 繋がったまま ready にならないソケットを残さない。
   */
  private rejectHello(peer: Peer, message: string): void {
    this.sendSyncError(peer.ws, message);
    try {
      peer.ws.close(1008, "sync_hello failed");
    } catch (error) {
      this.log(`failed to close a rejected peer: ${String(error)}`);
    }
  }

  private onUpdate(ws: WebSocket, encoded: string): void {
    const peer = this.peers.get(ws);
    if (!peer) {
      this.sendSyncError(ws, "join してから sync_update を送ってください");
      return;
    }
    if (peer.blocked) return;
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
    if (peer.blocked) return;
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
    if (peer.blocked) return;
    if (update.length === 0) {
      // 空の更新は何も変えない。保存が確定してから ACK を返す
      this.sendAck(peer.ws);
      return;
    }
    // 適用前に、merge できる更新の大きさと struct 数を制限する (巨大な文書を持ち込ませない)
    if (update.length > MAX_SYNC_UPDATE_BYTES) {
      this.sendSyncError(
        peer.ws,
        `更新が大きすぎます (上限 ${MAX_SYNC_UPDATE_BYTES} バイト)`,
      );
      return;
    }
    let structs: number;
    try {
      structs = countUpdateStructs(update);
    } catch {
      this.sendSyncError(peer.ws, "更新を解釈できませんでした");
      return;
    }
    if (structs > MAX_SYNC_UPDATE_STRUCTS) {
      this.sendSyncError(
        peer.ws,
        `更新に含まれる変更が多すぎます (上限 ${MAX_SYNC_UPDATE_STRUCTS})`,
      );
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
    // 適用後にオブジェクト数の上限を超えたら、以後このピアの更新は受け付けない (オブジェクトは消さない)
    if (this.store.world.count() > MAX_WORLD_OBJECTS) {
      peer.blocked = true;
      this.log(
        `peer ${peer.peerId} exceeded the object limit (${MAX_WORLD_OBJECTS}); ` +
          `the document now has ${this.store.world.count()} object(s)`,
      );
      this.sendSyncError(
        peer.ws,
        `オブジェクト数が上限 (${MAX_WORLD_OBJECTS}) を超えました。これ以降の更新は受け付けません`,
      );
      return;
    }
    // 同じ更新の再送などで Yjs が変更を出さない場合も、保存を待って ACK を返す
    if (this.updateCount === before) this.sendAck(peer.ws);
  }

  private onClaim(ws: WebSocket, msg: Extract<ClientMessage, { type: "claim" }>): void {
    const peer = this.peers.get(ws);
    if (!peer) return;
    if (!this.requireReady(ws)) return;
    const now = Date.now();
    this.pruneClaims(now);
    if (msg.until <= now) {
      this.sendSyncError(ws, "claim の期限が過ぎています");
      return;
    }
    if (msg.until > now + MAX_CLAIM_AHEAD_MS) {
      this.sendSyncError(ws, "claim の期限が長すぎます");
      return;
    }
    const key = `${peer.peerId}:${msg.id}:${msg.sessionId}`;
    this.rememberClaim(peer.peerId, key, msg.seq, msg.until);
    this.broadcast(
      { type: "claim", id: msg.id, peerId: peer.peerId, sessionId: msg.sessionId, seq: msg.seq, until: msg.until },
      ws,
    );
  }

  private onClaimRelease(ws: WebSocket, msg: Extract<ClientMessage, { type: "claim_release" }>): void {
    const peer = this.peers.get(ws);
    if (!peer) return;
    if (!this.requireReady(ws)) return;
    const now = Date.now();
    this.pruneClaims(now);
    const key = `${peer.peerId}:${msg.id}:${msg.sessionId}`;
    const seq = (this.claimSeqs.get(key)?.seq ?? 0) + 1;
    // release の seq は、後続の release と比べられるよう、しばらく保持する
    this.rememberClaim(peer.peerId, key, seq, now + CLAIM_RELEASE_RETENTION_MS);
    this.broadcast({ type: "claim", id: msg.id, peerId: peer.peerId, sessionId: msg.sessionId, seq, until: 0 }, ws);
  }

  /** 期限切れの claim seq を捨てる。 */
  private pruneClaims(now: number): void {
    for (const [key, entry] of this.claimSeqs) {
      if (entry.expiresAt <= now) this.claimSeqs.delete(key);
    }
  }

  /** claim seq を記録する。ピアごとの上限を超えたら、いちばん古い項目を追い出す。 */
  private rememberClaim(peerId: string, key: string, seq: number, expiresAt: number): void {
    if (!this.claimSeqs.has(key)) {
      const prefix = `${peerId}:`;
      let count = 0;
      for (const existing of this.claimSeqs.keys()) {
        if (existing.startsWith(prefix)) count++;
      }
      if (count >= MAX_CLAIM_SEQS_PER_PEER) {
        for (const existing of this.claimSeqs.keys()) {
          if (!existing.startsWith(prefix)) continue;
          this.claimSeqs.delete(existing);
          break;
        }
        this.log(`evicted an old claim seq for ${peerId} (limit ${MAX_CLAIM_SEQS_PER_PEER})`);
      }
    }
    this.claimSeqs.set(key, { seq, expiresAt });
  }

  /** テスト・診断用: 保持している claim seq の数 (peerId を渡すとそのピア分)。 */
  claimSeqCount(peerId?: string): number {
    if (peerId === undefined) return this.claimSeqs.size;
    const prefix = `${peerId}:`;
    let count = 0;
    for (const key of this.claimSeqs.keys()) {
      if (key.startsWith(prefix)) count++;
    }
    return count;
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
      this.sendAck(source.ws);
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

  /**
   * ACK は「ディスクに確定した state vector」だけを返す。
   * 未保存の変更があれば保存してから送り、失敗したら sync_error にする。
   */
  private sendAck(ws: WebSocket): void {
    const peer = this.peers.get(ws);
    if (!peer || peer.blocked || this.closed) return;
    void this.ackWhenDurable(peer);
  }

  private async ackWhenDurable(peer: Peer): Promise<void> {
    try {
      if (this.store.hasUnsavedChanges()) await this.store.scheduleSave();
    } catch (err) {
      this.sendSyncError(peer.ws, `保存できませんでした: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (peer.blocked || this.peers.get(peer.ws) !== peer || this.closed) return;
    this.send(peer.ws, { type: "sync_ack", stateVector: toBase64(this.store.durableVector()) });
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
