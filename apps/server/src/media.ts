/**
 * 動画のストリーミング配信のための、小さな純粋関数。
 * サーバーは `/media/<cid>` で、ブラウザの `<video>` が送る Range 要求に応えて、必要な範囲だけを IPFS から流す。
 */

export interface ByteRange {
  start: number;
  /** 最後のバイトの位置 (含む) */
  end: number;
}

/**
 * `Range: bytes=...` を解釈する。範囲が無ければ null、不正・範囲外なら "invalid"。
 * 対応する書式: `bytes=start-end`、`bytes=start-`、`bytes=-suffix` (末尾から suffix バイト)。
 * 複数範囲 (`bytes=0-1,3-4`) は対応しない (invalid)。
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return "invalid";

  let start: number;
  let end: number;
  if (startText === "") {
    // 末尾から N バイト
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start) || start < 0) return "invalid";
    end = endText === "" ? size - 1 : Number(endText);
    if (!Number.isSafeInteger(end) || end < start) return "invalid";
    end = Math.min(end, size - 1);
  }
  if (size <= 0 || start >= size) return "invalid";
  return { start, end };
}

export { mediaType } from "@proto/protocol";
