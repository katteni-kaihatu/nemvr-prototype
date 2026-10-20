import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  FILE_ICON_WIDTH,
  MAX_OBJECTS,
  type FileCategory,
  type IceServer,
  type IpfsInfo,
  TICK_RATE,
  type PeerInfo,
  type PeerState,
  type PlaceBox,
  type PlaceFile,
  type PlaceImage,
  type Pose,
  type Vec3,
  type ServerMessage,
  type WorldObject,
} from "@proto/protocol";
import { sanitizeName } from "./validate.js";

const COLORS = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
];

/**
 * 複製したときの、元からのずらし量 (m)。横にずらし、同一平面での重なり (描画のちらつき) を避けるため法線方向にも少しずらす。
 * 画像は大きいので少しだけ (重なってよい)、ファイルのアイコンは重ならない距離だけずらす。
 */
const DUPLICATE_SIDE_OFFSET = { image: 0.6, file: FILE_ICON_WIDTH + 0.15 } as const;
const DUPLICATE_NORMAL_OFFSET = 0.05;

const INITIAL_POSE: Pose = { position: [0, 0, 0], head: [0, 0, 0, 1] };

/** デモ空間の初期ボックス (位置関係が分かる目印)。World.tsx の静的メッシュを移したもの。 */
const INITIAL_BOXES: { position: Vec3; yaw: number; size: number; color: string }[] = [
  { position: [0, 0, 0], yaw: 0, size: 1, color: "#d9534f" },
  { position: [6, 0, -4], yaw: 0, size: 2, color: "#5bc0de" },
  { position: [-7, 0, -6], yaw: 0, size: 1.5, color: "#5cb85c" },
  { position: [10, 0, 8], yaw: 0, size: 1, color: "#f0ad4e" },
  { position: [-10, 0, 7], yaw: 0, size: 3, color: "#9b59b6" },
];

interface Peer {
  socket: WebSocket;
  state: PeerState;
}

export class Room {
  constructor(
    private readonly ipfs: IpfsInfo,
    /** 入室するユーザー用の STUN / TURN 設定を作る (TURN 未設定なら undefined)。 */
    private readonly iceServersFor: (userId: string) => IceServer[] | undefined = () => undefined,
  ) {}

  private peers = new Map<string, Peer>();
  private objects = new Map<string, WorldObject>();
  private joinCount = 0;
  private timer: NodeJS.Timeout | null = null;

  /** join 済みのピアを登録して welcome を返す。 */
  join(socket: WebSocket, rawName: unknown): PeerState {
    const id = randomUUID();
    const color = COLORS[this.joinCount % COLORS.length]!;
    this.joinCount++;
    const info: PeerInfo = { id, name: sanitizeName(rawName, id.slice(0, 4)), color };
    const state: PeerState = { ...info, pose: structuredClone(INITIAL_POSE) };

    const others = [...this.peers.values()].map((p) => p.state);
    this.peers.set(id, { socket, state });

    this.send(socket, {
      type: "welcome",
      self: info,
      peers: others,
      objects: [...this.objects.values()],
      ipfs: this.ipfs,
      iceServers: this.iceServersFor(id),
      tickRate: TICK_RATE,
    });
    this.broadcast({ type: "peer_joined", peer: state }, id);
    this.startTimer();
    return state;
  }

  /** デモ空間のボックスを配置する (つかんで動かせるサーバー同期オブジェクト)。サーバーの起動時に 1 回だけ呼ぶ。 */
  seedDemoBoxes(): void {
    for (const box of INITIAL_BOXES) {
      if (this.isFull) break;
      const object: WorldObject = { id: randomUUID(), kind: "box", ...box };
      this.objects.set(object.id, object);
    }
  }

  setPose(id: string, pose: Pose): void {
    const peer = this.peers.get(id);
    if (peer) peer.state.pose = pose;
  }

  /** VRM アバターの CID を記録して、本人以外に知らせる (null なら簡易アバターに戻す)。 */
  setAvatar(id: string, cid: string | null): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (cid === null) delete peer.state.avatarCid;
    else peer.state.avatarCid = cid;
    this.broadcast({ type: "peer_avatar", id, cid }, id);
  }

  /** 画像オブジェクトを追加して全員に通知する。上限に達していたら false。 */
  addImage(place: PlaceImage): boolean {
    if (this.objects.size >= MAX_OBJECTS) return false;
    const object: WorldObject = { id: randomUUID(), kind: "image", ...place };
    this.objects.set(object.id, object);
    this.broadcast({ type: "object_added", object });
    return true;
  }

  /**
   * オブジェクトをつかむ。つかんでいる間は、つかんだ本人だけが動かせる (排他)。
   * 他の人がつかんでいる場合は、本人にだけエラーと現在の状態を返す。
   * 1 人が同時につかめるのは 1 個まで (別のものをつかむと、前のものは離す)。
   */
  grabObject(peerId: string, id: string): void {
    const peer = this.peers.get(peerId);
    const object = this.objects.get(id);
    if (!peer || !object) return;
    if (object.heldBy && object.heldBy !== peerId) {
      this.send(peer.socket, { type: "error", message: "他の人がつかんでいます" });
      this.send(peer.socket, { type: "object_updated", object }); // 楽観的に始めた本人の側をやり直させる
      return;
    }
    this.releaseHeldBy(peerId, id);
    object.heldBy = peerId;
    this.broadcast({ type: "object_updated", object });
  }

  /** つかんでいる本人からの移動だけを受け付け、本人以外に配る (本人は手元で動かしている)。 */
  moveObject(peerId: string, id: string, position: Vec3, yaw: number, pitch?: number): void {
    const object = this.objects.get(id);
    if (!object || object.heldBy !== peerId) return;
    object.position = position;
    object.yaw = yaw;
    if (pitch === undefined) delete object.pitch;
    else object.pitch = pitch;
    this.broadcast({ type: "object_updated", object }, peerId);
  }

  releaseObject(peerId: string, id: string): void {
    const object = this.objects.get(id);
    if (!object || object.heldBy !== peerId) return;
    delete object.heldBy;
    this.broadcast({ type: "object_updated", object });
  }

  /** 削除して、削除したオブジェクトを返す。他の人がつかんでいるものや、存在しないものは null。 */
  deleteObject(peerId: string, id: string): WorldObject | null {
    const object = this.objects.get(id);
    if (!object) return null;
    if (object.heldBy && object.heldBy !== peerId) {
      this.sendError(peerId, "他の人がつかんでいます");
      return null;
    }
    this.objects.delete(id);
    this.broadcast({ type: "object_removed", id });
    return object;
  }

  /** 複製して、できたオブジェクトを返す。元の隣 (横に少しずらした位置) に、同じ内容・向き・大きさで置く。置けなければ null。 */
  duplicateObject(peerId: string, id: string): WorldObject | null {
    const object = this.objects.get(id);
    if (!object) return null;
    if (this.isFull) {
      this.sendError(peerId, "これ以上オブジェクトを置けません");
      return null;
    }
    const { yaw } = object;
    const [x, y, z] = object.position;
    const side = object.kind === "box" ? object.size + 0.2 : DUPLICATE_SIDE_OFFSET[object.kind]; // ボックスは重ならない距離
    const copy: WorldObject = {
      ...object,
      id: randomUUID(),
      // 平面のローカル +X (右) と法線 (+Z) を yaw 回したもの
      position: [
        x + Math.cos(yaw) * side + Math.sin(yaw) * DUPLICATE_NORMAL_OFFSET,
        y,
        z - Math.sin(yaw) * side + Math.cos(yaw) * DUPLICATE_NORMAL_OFFSET,
      ],
    };
    delete copy.heldBy;
    this.objects.set(copy.id, copy);
    this.broadcast({ type: "object_added", object: copy });
    return copy;
  }

  /** 指定のピアがつかんでいるオブジェクトを離す (keepId は除く)。 */
  private releaseHeldBy(peerId: string, keepId?: string): void {
    for (const object of this.objects.values()) {
      if (object.heldBy !== peerId || object.id === keepId) continue;
      delete object.heldBy;
      this.broadcast({ type: "object_updated", object });
    }
  }

  /**
   * ファイルオブジェクトを追加して全員に通知する。上限に達していたら false。
   * size と category は、サーバーが中身を取得して決めた値を渡す (クライアントの申告は使わない)。
   */
  /** デモ空間のボックスを追加して全員に通知する。上限に達していたら false。 */
  addBox(place: PlaceBox): boolean {
    if (this.objects.size >= MAX_OBJECTS) return false;
    const object: WorldObject = { id: randomUUID(), kind: "box", ...place };
    this.objects.set(object.id, object);
    this.broadcast({ type: "object_added", object });
    return true;
  }

  addFile(place: PlaceFile & { size: number; category: FileCategory; stored: boolean; owner?: string }): boolean {
    if (this.objects.size >= MAX_OBJECTS) return false;
    const object: WorldObject = { id: randomUUID(), kind: "file", ...place };
    this.objects.set(object.id, object);
    this.broadcast({ type: "object_added", object });
    return true;
  }

  /** サーバーが保持している、その内容 (CID) のファイルを 1 つ返す。無ければ undefined。 */
  findStoredFile(cid: string): Extract<WorldObject, { kind: "file" }> | undefined {
    for (const object of this.objects.values()) {
      if (object.kind === "file" && object.cid === cid && object.stored) return object;
    }
    return undefined;
  }

  /** まだサーバーが保持していない、その内容 (CID) のファイルを 1 つ返す。無ければ undefined。 */
  findUnstoredFile(cid: string): Extract<WorldObject, { kind: "file" }> | undefined {
    for (const object of this.objects.values()) {
      if (object.kind === "file" && object.cid === cid && !object.stored) return object;
    }
    return undefined;
  }

  /**
   * まだ保持していない、その内容 (CID) のファイルをすべて取り除いて、全員に知らせる。
   * 取得に失敗した (容量が足りない・取得できない) ときに使う。取り除いた数を返す。
   * 置いた人が退室して「オフライン」になっているものは、取り除かない (オフラインのまま残す)。
   */
  removeUnstored(cid: string): number {
    let removed = 0;
    for (const object of [...this.objects.values()]) {
      if (object.kind !== "file" || object.cid !== cid || object.stored || object.offline) continue;
      this.objects.delete(object.id);
      this.broadcast({ type: "object_removed", id: object.id });
      removed++;
    }
    return removed;
  }

  getObject(id: string): WorldObject | undefined {
    return this.objects.get(id);
  }

  /**
   * サーバーが、その内容 (CID) を保持した。同じ CID を指す、まだ保持していなかったファイルすべてを「保持済み」にして、
   * 全員に知らせる (実測のサイズに直し、配っていた人・オフラインの印は外す)。更新したものを返す。
   */
  markStored(cid: string, size: number): WorldObject[] {
    const updated: WorldObject[] = [];
    for (const object of this.objects.values()) {
      if (object.kind !== "file" || object.cid !== cid || object.stored) continue;
      object.stored = true;
      object.size = size;
      delete object.owner;
      delete object.offline;
      updated.push(object);
      this.broadcast({ type: "object_updated", object });
    }
    return updated;
  }

  /** 中身を配っていた人が退室した。まだ保持していないファイルは、取得できないので「オフライン」にして知らせる。 */
  private markOffline(ownerId: string): void {
    for (const object of this.objects.values()) {
      if (object.kind !== "file" || object.stored || object.owner !== ownerId || object.offline) continue;
      object.offline = true;
      this.broadcast({ type: "object_updated", object });
    }
  }

  /** ダウンロードのための取得 (request_file) の進捗を、要求した本人にだけ知らせる。 */
  sendPrepareProgress(id: string, cid: string, loaded: number, total?: number, queued?: boolean): void {
    const peer = this.peers.get(id);
    if (peer) this.send(peer.socket, { type: "prepare_progress", cid, loaded, total, ...(queued ? { queued } : {}) });
  }

  sendPrepareFailed(id: string, cid: string, message: string): void {
    const peer = this.peers.get(id);
    if (peer) this.send(peer.socket, { type: "prepare_failed", cid, message });
  }

  /** ピアの libp2p ID を本人以外に知らせる (受け取った側が直接接続しに行く)。 */
  announceIpfs(id: string, ipfsPeerId: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.state.ipfsPeerId = ipfsPeerId;
    this.broadcast({ type: "peer_ipfs", id, ipfsPeerId }, id);
  }

  /** そのユーザーの libp2p ピア ID (まだ知らせてきていなければ undefined)。ログで、取得元が誰か分かるようにするため。 */
  ipfsPeerIdOf(id: string): string | undefined {
    return this.peers.get(id)?.state.ipfsPeerId;
  }

  /** 置こうとしている中身の取得の進捗を、置いている本人にだけ知らせる。 */
  sendPlaceProgress(id: string, cid: string, loaded: number, total?: number, queued?: boolean): void {
    const peer = this.peers.get(id);
    if (peer) this.send(peer.socket, { type: "place_progress", cid, loaded, total, ...(queued ? { queued } : {}) });
  }

  /** 1 人にだけエラーを通知する (切断はしない)。 */
  sendError(id: string, message: string): void {
    const peer = this.peers.get(id);
    if (peer) this.send(peer.socket, { type: "error", message });
  }

  leave(id: string): void {
    if (!this.peers.delete(id)) return;
    this.broadcast({ type: "peer_left", id });
    this.releaseHeldBy(id); // つかんだまま切断しても、オブジェクトが固まらないようにする
    this.markOffline(id); // 配っていたファイルは、取得できなくなる
    if (this.peers.size === 0) this.stopTimer();
  }

  get isFull(): boolean {
    return this.objects.size >= MAX_OBJECTS;
  }

  get size(): number {
    return this.peers.size;
  }

  close(): void {
    this.stopTimer();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const poses: Record<string, Pose> = {};
    for (const [id, p] of this.peers) poses[id] = p.state.pose;
    this.broadcast({ type: "snapshot", time: Date.now(), poses });
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, exceptId?: string): void {
    const text = JSON.stringify(msg);
    for (const [id, p] of this.peers) {
      if (id === exceptId) continue;
      if (p.socket.readyState === p.socket.OPEN) p.socket.send(text);
    }
  }
}
