import { randomUUID } from "node:crypto";
import { MAX_IMAGES } from "@proto/protocol";

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (b: Uint8Array, bytes: number[], offset = 0) =>
  b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v);

/**
 * 先頭バイト (マジックナンバー) から画像形式を判定する。
 * クライアントが申告する Content-Type は信用しない。SVG は XSS の恐れがあるため対象外。
 */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif"; // GIF87a / GIF89a
  }
  // "RIFF" .... "WEBP"
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

export interface StoredImage {
  type: ImageType;
  data: Buffer;
}

/** アップロードされた画像をメモリに保持する (プロトタイプのため永続化しない)。 */
export class ImageStore {
  private images = new Map<string, StoredImage>();

  get isFull(): boolean {
    return this.images.size >= MAX_IMAGES;
  }

  /** 登録して ID を返す。形式が不正・満杯なら理由を返す。 */
  add(data: Buffer): { id: string } | { error: "unsupported" | "full" } {
    const type = sniffImageType(data);
    if (!type) return { error: "unsupported" };
    if (this.isFull) return { error: "full" };
    const id = randomUUID();
    this.images.set(id, { type, data });
    return { id };
  }

  get(id: string): StoredImage | undefined {
    return this.images.get(id);
  }

  has(id: string): boolean {
    return this.images.has(id);
  }
}
