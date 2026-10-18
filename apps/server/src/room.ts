import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  MAX_OBJECTS,
  type IceServer,
  type IpfsInfo,
  TICK_RATE,
  type PeerInfo,
  type PeerState,
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

/** 複製したときの、元からのずらし量 (m)。横にずらし、同一平面での重なり (描画のちらつき) を避けるため法線方向にも少しずらす。 */
const DUPLICATE_SIDE_OFFSET = 0.6;
const DUPLICATE_NORMAL_OFFSET = 0.05;

const INITIAL_POSE: Pose = { position: [0, 0, 0], head: [0, 0, 0, 1] };

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

  setPose(id: string, pose: Pose): void {
    const peer = this.peers.get(id);
    if (peer) peer.state.pose = pose;
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
  moveObject(peerId: string, id: string, position: Vec3, yaw: number): void {
    const object = this.objects.get(id);
    if (!object || object.heldBy !== peerId) return;
    object.position = position;
    object.yaw = yaw;
    this.broadcast({ type: "object_updated", object }, peerId);
  }

  releaseObject(peerId: string, id: string): void {
    const object = this.objects.get(id);
    if (!object || object.heldBy !== peerId) return;
    delete object.heldBy;
    this.broadcast({ type: "object_updated", object });
  }

  /** 削除する。他の人がつかんでいるものは削除できない。 */
  deleteObject(peerId: string, id: string): void {
    const object = this.objects.get(id);
    if (!object) return;
    if (object.heldBy && object.heldBy !== peerId) {
      this.sendError(peerId, "他の人がつかんでいます");
      return;
    }
    this.objects.delete(id);
    this.broadcast({ type: "object_removed", id });
  }

  /** 複製する。元の隣 (横に少しずらした位置) に、同じ画像・向き・大きさで置く。 */
  duplicateObject(peerId: string, id: string): void {
    const object = this.objects.get(id);
    if (!object) return;
    if (this.isFull) {
      this.sendError(peerId, "これ以上オブジェクトを置けません");
      return;
    }
    const { yaw } = object;
    const [x, y, z] = object.position;
    const copy: WorldObject = {
      ...object,
      id: randomUUID(),
      // 平面のローカル +X (右) と法線 (+Z) を yaw 回したもの
      position: [
        x + Math.cos(yaw) * DUPLICATE_SIDE_OFFSET + Math.sin(yaw) * DUPLICATE_NORMAL_OFFSET,
        y,
        z - Math.sin(yaw) * DUPLICATE_SIDE_OFFSET + Math.cos(yaw) * DUPLICATE_NORMAL_OFFSET,
      ],
    };
    delete copy.heldBy;
    this.objects.set(copy.id, copy);
    this.broadcast({ type: "object_added", object: copy });
  }

  /** 指定のピアがつかんでいるオブジェクトを離す (keepId は除く)。 */
  private releaseHeldBy(peerId: string, keepId?: string): void {
    for (const object of this.objects.values()) {
      if (object.heldBy !== peerId || object.id === keepId) continue;
      delete object.heldBy;
      this.broadcast({ type: "object_updated", object });
    }
  }

  /** ピアの libp2p ID を本人以外に知らせる (受け取った側が直接接続しに行く)。 */
  announceIpfs(id: string, ipfsPeerId: string): void {
    if (this.peers.has(id)) this.broadcast({ type: "peer_ipfs", id, ipfsPeerId }, id);
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
