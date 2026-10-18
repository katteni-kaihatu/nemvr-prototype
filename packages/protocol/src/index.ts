// client / server 間で共有するメッセージ型と定数。実行時依存なし。

export const TICK_RATE = 20; // Hz
export const MAX_NAME_LENGTH = 24;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_ABS_POSITION = 1000;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** ユーザーの姿勢。position は足元のワールド座標、head は頭の向き。 */
export interface Pose {
  position: Vec3;
  head: Quat;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string; // "#rrggbb"
}

export interface PeerState extends PeerInfo {
  pose: Pose;
}

// Client -> Server
export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "pose"; pose: Pose };

// Server -> Client
export type ServerMessage =
  | { type: "welcome"; self: PeerInfo; peers: PeerState[]; tickRate: number }
  | { type: "peer_joined"; peer: PeerState }
  | { type: "peer_left"; id: string }
  | { type: "snapshot"; time: number; poses: Record<string, Pose> }
  | { type: "error"; message: string };
