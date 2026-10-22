// client / server 間で共有するメッセージ型と定数。実行時依存なし。

import type { FileCategory } from "./files.js";
import type {
  JsonValue,
  SpaceChange,
  SpaceCondition,
  SpaceEntity,
  SpaceFilter,
  SpaceMutation,
  SpaceScope,
} from "./space.js";

export * from "./files.js";
export * from "./space.js";

export const TICK_RATE = 20; // Hz
export const MAX_NAME_LENGTH = 24;
export const MAX_MESSAGE_BYTES = 4096;

/** 貼り付けを受け付ける URL の長さの上限。 */
export const MAX_URL_LENGTH = 2048;
export const MAX_ABS_POSITION = 1000;

// 画像オブジェクト (画像本体は IPFS で共有し、ワールドには CID だけを載せる)
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 1 枚あたりの上限
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // ファイル 1 個あたりの上限 (2 GiB)
// VRM アバター (ブラウザが IPFS にアップロードする) の 1 個あたりの上限
export const MAX_AVATAR_BYTES = 64 * 1024 * 1024;
/**
 * これ以下のファイルは、サーバーが全部取得して保持してから置く (置いた人が退室しても使える)。
 * これより大きいファイルは、取得に時間がかかるので、先に置き (`stored: false`)、サーバーがバックグラウンドで取得する。
 * 置いた人は、取り終えるまで配り続ける。
 */
export const EAGER_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_OBJECTS = 100; // ワールドに置けるオブジェクトの最大数
export const MIN_OBJECT_SIZE = 0.1; // m
export const MAX_OBJECT_SIZE = 20; // m
/** つかんだオブジェクトを拡大・縮小できる倍率の範囲。無い場合は 1。 */
export const MIN_OBJECT_SCALE = 0.1;
export const MAX_OBJECT_SCALE = 10;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** ユーザーの姿勢。position は足元のワールド座標 (ジャンプ中は地面より上)、head は頭の向き。 */
export interface Pose {
  position: Vec3;
  head: Quat;
  /** しゃがみの深さ (0 = 立っている、1 = しゃがみきっている)。無ければ 0。 */
  crouch?: number;
  /** リーン (体を横に傾ける)。-1 = 左いっぱい、0 = まっすぐ、1 = 右いっぱい。無ければ 0。 */
  lean?: number;
}

/** 動画の再生状態。サーバーが保持し、全員に配る。time は動画内の秒、at はサーバーの時刻 (ms)。 */
export interface VideoPlaybackState {
  playing: boolean;
  time: number;
  at: number;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string; // "#rrggbb"
  /** ユーザーがアップロードした VRM の CID。無ければ簡易アバターを使う。 */
  avatarCid?: string;
}

export interface PeerState extends PeerInfo {
  pose: Pose;
  /**
   * このユーザーのブラウザ内 IPFS ノードの libp2p ピア ID (`peer.ipfsPeerId` 次元)。
   * ダウンロードの取得元 (どのピアからブロックが届いたか) に、ユーザー名を出すために使う。
   */
  ipfsPeerId?: string;
}

/** ワールドに置かれたオブジェクトに共通の項目。 */
interface ObjectBase {
  id: string;
  /** 位置 (ワールド座標)。下辺中央。 */
  position: Vec3;
  /** Y 軸回りの向き (rad)。法線は +Z を yaw だけ回した向き。 */
  yaw: number;
  /** X 軸回りの向き (rad, 上向きが正)。回転順序は YXZ。未指定なら 0。 */
  pitch?: number;
  /** 大きさの倍率 (1 = 元の大きさ)。未指定なら 1。下辺 (底面) の中央を中心に拡大・縮小する。 */
  scale?: number;
  /** 今このオブジェクトをつかんでいる人 (PeerInfo.id)。つかまれていなければ無い。 */
  heldBy?: string;
}

/**
 * ワールドに置かれた画像。鉛直な平面。
 * position は平面の下辺中央のワールド座標、width / height は m。
 */
export interface ImageObject extends ObjectBase {
  kind: "image";
  cid: string;
  width: number;
  height: number;
  name?: string;
  /** サーバーが内容を取得して保持しているか。未取得でも、置いた人のブラウザから配れる。 */
  stored?: boolean;
  owner?: string;
  offline?: boolean;
}

/**
 * ワールドに置かれた任意のファイル。ファイルの形のアイコンで表示する (音声・映像は専用のアイコン)。
 * 大きさは固定 (FILE_ICON_WIDTH x FILE_ICON_HEIGHT)。中身は CID で IPFS から取得する。
 */
export interface FileObject extends ObjectBase {
  kind: "file";
  cid: string;
  name: string;
  size: number;
  stored: boolean;
  owner?: string;
  offline?: boolean;
  category: FileCategory;
}

/**
 * デモ空間のボックス。サーバー同期オブジェクトで、つかんで動かせる。
 * size は一辺 (m)、color は "#rrggbb"。
 */
export interface BoxObject extends ObjectBase {
  kind: "box";
  size: number;
  color: string;
}

/**
 * 3D 空間に置かれたリンク (URL)。中身 (ファイル) は持たない。
 * 画像・動画・音声ではない URL (HTML など) を貼ったときに作る。リングメニューからブラウザの別タブで開く。
 */
export interface LinkObject extends ObjectBase {
  kind: "link";
  url: string;
}

export type WorldObject = ImageObject | FileObject | BoxObject | LinkObject;

/** サーバーの IPFS (libp2p) ノードへの接続情報。ホスト名はクライアントがページの接続先から補う。 */
export interface IpfsInfo {
  peerId: string;
  wsPort: number; // libp2p の WebSocket 待受ポート
}

/**
 * WebRTC (ブラウザ同士の直接接続) に使う STUN / TURN サーバー。RTCIceServer と同じ形。
 * TURN の認証情報は時間制限つきで、サーバーが入室 (space_welcome) ごとに発行する。
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

// ---- v2 プロトコル ----

export interface SpaceSelf {
  peerId: string;
  entityId: string;
  name: string;
  color: string;
}

export type ClientMessage =
  | {
      type: "space_join";
      name: string;
      sessionId?: string;
      templateId: string;
      schemaVersion: number;
    }
  | { type: "space_query"; requestId: string; filter: SpaceFilter; limit?: number }
  | { type: "space_subscribe"; subscriptionId: string; filter: SpaceFilter }
  | { type: "space_unsubscribe"; subscriptionId: string }
  | { type: "space_mutate"; mutation: SpaceMutation }
  | {
      type: "space_import_url";
      commandId: string;
      entityId: string;
      url: string;
      position: Vec3;
      yaw: number;
      pitch?: number;
    }
  | { type: "space_set_avatar"; commandId: string; cid: string | null }
  | { type: "file_request"; commandId: string; entityId: string };

export type ServerMessage =
  | {
      type: "space_welcome";
      self: SpaceSelf;
      sessionId: string;
      templateId: string;
      schemaVersion: number;
      scope: SpaceScope;
      dimensions: Record<string, unknown>;
      subscriptionId: string;
      version: number;
      seq: number;
      at: number;
      entities: SpaceEntity[];
      ipfs: IpfsInfo;
      iceServers?: IceServer[];
      tickRate: number;
    }
  | {
      type: "space_snapshot";
      subscriptionId: string;
      version: number;
      seq: number;
      at: number;
      entities: SpaceEntity[];
    }
  | {
      type: "space_delta";
      subscriptionId: string;
      version: number;
      seq: number;
      at: number;
      changes: SpaceChange[];
    }
  | { type: "space_query_result"; requestId: string; version: number; entities: SpaceEntity[] }
  | { type: "space_ack"; commandId: string; version: number; entityId?: string }
  | { type: "space_error"; commandId?: string; code: string; message: string }
  | {
      type: "file_progress";
      entityId?: string;
      cid?: string;
      loaded: number;
      total?: number;
      queued?: boolean;
      role?: "place" | "prepare";
    }
  | { type: "file_failed"; entityId?: string; cid?: string; message: string; role?: "prepare" | "fallback" };

/** 旧クライアント互換のためのヘルパー型 (v2 ではメッセージには使わない)。 */
export type PlaceImage = Pick<ImageObject, "cid" | "position" | "yaw" | "width" | "height" | "name"> & {
  objectId?: string;
};
export type PlaceFile = Pick<FileObject, "cid" | "name" | "position" | "yaw"> & { objectId?: string };
export type PlaceUrl = Pick<LinkObject, "url" | "position" | "yaw"> & { objectId?: string };
export type PlaceBox = Pick<BoxObject, "position" | "yaw" | "size" | "color"> & {
  pitch?: number;
  objectId?: string;
};

export type SpaceJsonValue = JsonValue;
export type SpaceConditionMessage = SpaceCondition;
