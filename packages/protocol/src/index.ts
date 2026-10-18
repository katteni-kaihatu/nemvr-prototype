// client / server 間で共有するメッセージ型と定数。実行時依存なし。

import type { FileCategory } from "./files.js";

export * from "./files.js";

export const TICK_RATE = 20; // Hz
export const MAX_NAME_LENGTH = 24;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_ABS_POSITION = 1000;

// 画像オブジェクト (画像本体は IPFS で共有し、ワールドには CID だけを載せる)
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 1 枚あたりの上限
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // ファイル 1 個あたりの上限 (2 GiB)
/**
 * これ以下のファイルは、置いた時点でサーバーが全部取得して保持する (置いた人が退室しても使える)。
 * これより大きいファイルは、ダウンロードされるまで取得しない (遅延転送)。置いた人が、その間は配り続ける。
 */
export const EAGER_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_OBJECTS = 100; // ワールドに置けるオブジェクトの最大数
export const MIN_OBJECT_SIZE = 0.1; // m
export const MAX_OBJECT_SIZE = 20; // m
export const GRAB_REACH = 8; // m。画面中央のレイがこの距離までのオブジェクトをつかめる

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

/** ワールドに置かれたオブジェクトに共通の項目。 */
interface ObjectBase {
  id: string; // サーバーが採番
  /** 位置 (ワールド座標)。下辺中央。 */
  position: Vec3;
  /** Y 軸回りの向き (rad)。法線は +Z を yaw だけ回した向き。 */
  yaw: number;
  /** X 軸回りの向き (rad, 上向きが正)。回転順序は YXZ。未指定なら 0。 */
  pitch?: number;
  /** 今このオブジェクトをつかんでいる人 (PeerInfo.id)。つかまれていなければ無い。 */
  heldBy?: string;
}

/**
 * ワールドに置かれた画像。鉛直な平面。
 * position は平面の下辺中央のワールド座標、width / height は m。
 */
export interface ImageObject extends ObjectBase {
  kind: "image";
  cid: string; // 画像 (UnixFS ファイル) の CID。IPFS から取得する
  width: number;
  height: number;
  /** 元のファイル名 (ダウンロード時の名前)。無いこともある。 */
  name?: string;
}

/**
 * ワールドに置かれた任意のファイル。ファイルの形のアイコンで表示する (音声・映像は専用のアイコン)。
 * 大きさは固定 (FILE_ICON_WIDTH x FILE_ICON_HEIGHT)。中身は CID で IPFS から取得する。
 */
export interface FileObject extends ObjectBase {
  kind: "file";
  cid: string; // ファイル (UnixFS ファイル) の CID
  /** ファイル名。サーバーが sanitizeFileName で整えたもの。 */
  name: string;
  /**
   * バイト数。`stored` なら、サーバーが実際に取得して測った値。
   * まだなら、ファイルのメタデータから読んだ宣言のサイズ (置いた人の申告。実際の取得のときに、上限を守らせる)。
   */
  size: number;
  /**
   * サーバーが中身を保持しているか。保持していれば、置いた人が退室しても取得できる。
   * 大きなファイルは、ダウンロードされるまで保持しない (false)。その間は、置いた人 (`owner`) が配る。
   */
  stored: boolean;
  /** まだ保持していないファイルを配っている人 (PeerInfo.id)。`stored` になると無くなる。 */
  owner?: string;
  /** 保持しておらず、配っている人も退室した。取得できない。 */
  offline?: boolean;
  /** アイコンの種類。サーバーが名前と中身から判定する。 */
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

export type WorldObject = ImageObject | FileObject | BoxObject;

/** サーバーの IPFS (libp2p) ノードへの接続情報。ホスト名はクライアントがページの接続先から補う。 */
export interface IpfsInfo {
  peerId: string;
  wsPort: number; // libp2p の WebSocket 待受ポート
}

/**
 * WebRTC (ブラウザ同士の直接接続) に使う STUN / TURN サーバー。RTCIceServer と同じ形。
 * TURN の認証情報は時間制限つきで、サーバーが入室 (welcome) ごとに発行する。
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** place_image の本体部分 (id はサーバーが採番する)。サーバーは cid の中身を検証してから置く。 */
export type PlaceImage = Pick<ImageObject, "cid" | "position" | "yaw" | "width" | "height" | "name">;

/**
 * place_file の本体部分。size と category はサーバーが中身から決めるので、クライアントは送らない。
 * サーバーは cid の中身を取得して (上限 MAX_FILE_BYTES) から置く。
 */
export type PlaceFile = Pick<FileObject, "cid" | "name" | "position" | "yaw">;

/** place_box の本体部分 (id はサーバーが採番する)。デモ用のボックス配置・テスト用。 */
export type PlaceBox = Pick<BoxObject, "position" | "yaw" | "size" | "color"> & { pitch?: number };

// Client -> Server
export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "pose"; pose: Pose }
  | ({ type: "place_image" } & PlaceImage)
  | ({ type: "place_file" } & PlaceFile)
  | ({ type: "place_box" } & PlaceBox)
  // まだサーバーが保持していないファイル (大きなファイル) を、ダウンロードするために、サーバーに取得させる
  | { type: "request_file"; id: string }
  // 自分の libp2p ピア ID を他のユーザーに知らせる (ブラウザ同士の直接接続用)
  | { type: "ipfs_peer"; peerId: string }
  // オブジェクトの操作。つかんでいる間は、つかんだ本人だけが move できる (排他)
  | { type: "grab_object"; id: string }
  | { type: "move_object"; id: string; position: Vec3; yaw: number; pitch?: number }
  | { type: "release_object"; id: string }
  | { type: "delete_object"; id: string }
  | { type: "duplicate_object"; id: string };

// Server -> Client
export type ServerMessage =
  | {
      type: "welcome";
      self: PeerInfo;
      peers: PeerState[];
      objects: WorldObject[];
      ipfs: IpfsInfo;
      /** STUN / TURN の設定。サーバーに TURN が設定されていないときは省略される (クライアントは既定の公開 STUN を使う)。 */
      iceServers?: IceServer[];
      tickRate: number;
    }
  | { type: "object_added"; object: WorldObject }
  // 位置・向き・つかまれている状態が変わった (全体の状態を送る)
  | { type: "object_updated"; object: WorldObject }
  | { type: "object_removed"; id: string }
  // サーバーが、置こうとしている中身を IPFS から取得している途中の進捗 (置いた本人にだけ送る)。
  // 大きなファイルは数分かかるので、その間も状況が分かるようにする。total はサーバーが分かっていれば (宣言サイズ)
  // queued: 他の転送の順番待ちをしている (まだ取得を始めていない)
  | { type: "place_progress"; cid: string; loaded: number; total?: number; queued?: boolean }
  // request_file の進捗 (サーバーが、置いた人から取得している途中)。要求した人にだけ送る
  | { type: "prepare_progress"; cid: string; loaded: number; total?: number; queued?: boolean }
  // request_file が失敗した (置いた人が退室した、容量が足りない、など)
  | { type: "prepare_failed"; cid: string; message: string }
  // 他のユーザーが IPFS ノードの準備を終えた。受け取った側がそのピアへ接続しに行く
  | { type: "peer_ipfs"; id: string; ipfsPeerId: string }
  | { type: "peer_joined"; peer: PeerState }
  | { type: "peer_left"; id: string }
  | { type: "snapshot"; time: number; poses: Record<string, Pose> }
  | { type: "error"; message: string };
