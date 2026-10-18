// client / server 間で共有するメッセージ型と定数。実行時依存なし。

export const TICK_RATE = 20; // Hz
export const MAX_NAME_LENGTH = 24;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_ABS_POSITION = 1000;

// 画像オブジェクト
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 1 枚あたりのアップロード上限
export const MAX_IMAGES = 50; // サーバーが保持する画像の最大数
export const MAX_OBJECTS = 100; // ワールドに置けるオブジェクトの最大数
export const MIN_OBJECT_SIZE = 0.1; // m
export const MAX_OBJECT_SIZE = 20; // m
export const IMAGE_UPLOAD_PATH = "/images"; // POST で登録、GET /images/:id で取得

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

/**
 * ワールドに置かれた画像。鉛直な平面で、法線は +Z を yaw (Y 軸回り, rad) だけ回した向き。
 * position は平面の下辺中央のワールド座標、width / height は m。
 */
export interface ImageObject {
  id: string;
  kind: "image";
  imageId: string; // GET /images/:imageId で取得できる
  position: Vec3;
  yaw: number;
  width: number;
  height: number;
}

export type WorldObject = ImageObject;

/** place_image の本体部分 (id はサーバーが採番する)。 */
export type PlaceImage = Omit<ImageObject, "id" | "kind">;

// Client -> Server
export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "pose"; pose: Pose }
  | ({ type: "place_image" } & PlaceImage);

// Server -> Client
export type ServerMessage =
  | {
      type: "welcome";
      self: PeerInfo;
      peers: PeerState[];
      objects: WorldObject[];
      tickRate: number;
    }
  | { type: "object_added"; object: WorldObject }
  | { type: "peer_joined"; peer: PeerState }
  | { type: "peer_left"; id: string }
  | { type: "snapshot"; time: number; poses: Record<string, Pose> }
  | { type: "error"; message: string };
