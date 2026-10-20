import type * as Y from "yjs";
import type { FileObject, SyncPart, Vec3 } from "@proto/protocol";

export type { SyncPart };

export const WORLD_SCHEMA_VERSION = 1;

export type WorldObjectKind = "image" | "file" | "box" | "link";

export interface WorldTransform {
  position: Vec3;
  yaw: number;
  pitch?: number;
  updateId: string;
  actorId: string;
  at: number;
}

export type ObjectMetadataPatch = Partial<
  Pick<FileObject, "stored" | "size" | "category" | "owner" | "offline" | "name">
>;

export interface WorldDocOptions {
  actorId: string;
  now?: () => number;
  idFactory?: () => string;
  /** 既存の Y.Doc を使う (テスト・保存データのロード用)。 */
  doc?: Y.Doc;
}

/** 文書内の未検証なレコード (projection の入力)。 */
export interface RawObjectRecord {
  id: string;
  kind: unknown;
  transform: unknown;
  [key: string]: unknown;
}
