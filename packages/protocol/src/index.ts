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
  /** バイト数。サーバーが実際に取得して測った値 (クライアントの申告ではない)。 */
  size: number;
  /** アイコンの種類。サーバーが名前と中身から判定する。 */
  category: FileCategory;
}

export type WorldObject = ImageObject | FileObject;

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

// Client -> Server
export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "pose"; pose: Pose }
  | ({ type: "place_image" } & PlaceImage)
  | ({ type: "place_file" } & PlaceFile)
  // 自分の libp2p ピア ID を他のユーザーに知らせる (ブラウザ同士の直接接続用)
  | { type: "ipfs_peer"; peerId: string }
  // オブジェクトの操作。つかんでいる間は、つかんだ本人だけが move できる (排他)
  | { type: "grab_object"; id: string }
  | { type: "move_object"; id: string; position: Vec3; yaw: number }
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
  // 他のユーザーが IPFS ノードの準備を終えた。受け取った側がそのピアへ接続しに行く
  | { type: "peer_ipfs"; id: string; ipfsPeerId: string }
  | { type: "peer_joined"; peer: PeerState }
  | { type: "peer_left"; id: string }
  | { type: "snapshot"; time: number; poses: Record<string, Pose> }
  | { type: "error"; message: string };
