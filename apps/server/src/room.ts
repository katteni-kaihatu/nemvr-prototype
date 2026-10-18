import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  TICK_RATE,
  type PeerInfo,
  type PeerState,
  type Pose,
  type ServerMessage,
} from "@proto/protocol";
import { sanitizeName } from "./validate.js";

const COLORS = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
];

const INITIAL_POSE: Pose = { position: [0, 0, 0], head: [0, 0, 0, 1] };

interface Peer {
  socket: WebSocket;
  state: PeerState;
}

export class Room {
  private peers = new Map<string, Peer>();
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

    this.send(socket, { type: "welcome", self: info, peers: others, tickRate: TICK_RATE });
    this.broadcast({ type: "peer_joined", peer: state }, id);
    this.startTimer();
    return state;
  }

  setPose(id: string, pose: Pose): void {
    const peer = this.peers.get(id);
    if (peer) peer.state.pose = pose;
  }

  leave(id: string): void {
    if (!this.peers.delete(id)) return;
    this.broadcast({ type: "peer_left", id });
    if (this.peers.size === 0) this.stopTimer();
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
