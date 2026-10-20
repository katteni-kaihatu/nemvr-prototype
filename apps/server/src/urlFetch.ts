import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MAX_IMAGE_BYTES, MAX_URL_LENGTH, formatBytes } from "@proto/protocol";
import { sniffImageType, type ImageType } from "./images.js";

/**
 * 貼られた URL の取得。ブラウザの CORS を避けるため、サーバーで取得する。
 *
 * - http(s) だけ。localhost・プライベート IP・リンクローカルなど (SSRF の的になる宛先) は拒否する
 * - リダイレクトは手動で追い、各ホップの宛先を同じように検査する (最大 3 回)
 * - 画像は 5MiB、動画・音声は 128MiB まで。それ以外 (HTML など) は本文を読まずにリンクにする
 * - 画像の大きさは、先頭のヘッダーから求める (クライアントで置いた画像と同じように、長辺 2.5m に合わせる)
 */
export const URL_FETCH_MAX_BYTES = 128 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;
const IMAGE_LONG_EDGE = 2.5;
const MIN_OBJECT_SIZE = 0.1;

export type UrlKind = "image" | "video" | "audio" | "link";

export interface FetchedUrl {
  kind: UrlKind;
  /** 最終的な URL (リダイレクト後) */
  url: string;
  name: string;
  contentType: string;
  size: number;
  bytes?: Uint8Array;
  width?: number;
  height?: number;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
const AUDIO_EXTENSIONS = /\.(mp3|m4a|ogg|oga|wav|flac)$/i;

/** プライベート・予約済みの IP か (SSRF を避けるため、取得を拒否する)。 */
export function isPrivateAddress(address: string): boolean {
  const v = address.trim().toLowerCase();
  const family = isIP(v);
  if (family === 4) {
    const octets = v.split(".").map(Number);
    const [a = 0, b = 0] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // ベンチマーク用
    if (a >= 224) return true; // マルチキャスト・予約
    return false;
  }
  if (family === 6) {
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice("::ffff:".length));
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // ユニークローカル
    if (/^fe[89ab]/.test(v)) return true; // リンクローカル
    if (v.startsWith("2001:db8")) return true; // ドキュメント用
    if (v.startsWith("ff")) return true; // マルチキャスト
    return false;
  }
  return true; // 判定できないものは拒否
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** http(s) で、公開された宛先だけを許可する。 */
export async function assertPublicUrl(input: string): Promise<URL> {
  if (input.length > MAX_URL_LENGTH) throw new Error("URL が長すぎます");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("URL が正しくありません");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http(s) の URL だけを貼れます");
  if (url.username || url.password) throw new Error("認証情報を含む URL は使えません");
  const host = hostnameOf(url);
  if (!host) throw new Error("URL が正しくありません");
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".home.arpa")) {
    throw new Error("この URL は取得できません");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("この URL は取得できません");
    return url;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error("URL のホストを解決できませんでした");
  }
  if (addresses.length === 0) throw new Error("URL のホストを解決できませんでした");
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error("この URL は取得できません");
  return url;
}

function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/ogg": ".ogv",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/flac": ".flac",
  };
  return map[contentType] ?? "";
}

/** URL からファイル名を作る (パスの末尾。拡張子が無ければ Content-Type から補う)。 */
export function fileNameFromUrl(url: string, contentType = ""): string {
  let pathname = "";
  let hostname = "link";
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    hostname = parsed.hostname;
  } catch {
    // そのまま
  }
  let fromPath = "";
  try {
    fromPath = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    fromPath = pathname.split("/").filter(Boolean).pop() ?? "";
  }
  fromPath = fromPath.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  let name = fromPath || hostname.replace(/[^A-Za-z0-9.-]/g, "_");
  // パスに拡張子が無いとき、ホスト名だけのときは、Content-Type から拡張子を補う
  const extension = extensionFor(contentType);
  if (extension && (!fromPath || !/\.[A-Za-z0-9]{1,8}$/.test(name))) name += extension;
  return name.slice(0, 80);
}

/** 画像の大きさ (ビットマップのヘッダーから)。分からなければ null。 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type: ImageType | null = sniffImageType(bytes);
  if (type === "image/png") {
    if (bytes.length < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === "image/gif") {
    if (bytes.length < 10) return null;
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (type === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      // SOF0..SOF15 (C4, C8, CC は除く)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (type === "image/webp") {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8 ") {
      if (bytes.length < 30) return null;
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === "VP8L") {
      if (bytes.length < 25) return null;
      const b = bytes;
      return {
        width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
        height: 1 + (((b[24]! & 0xf) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)),
      };
    }
    if (chunk === "VP8X") {
      if (bytes.length < 30) return null;
      return {
        width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
      };
    }
    return null;
  }
  return null;
}

async function readBody(res: Response, limit: number, tooLarge: string): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error(tooLarge);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function readMedia(res: Response, finalUrl: URL): Promise<FetchedUrl> {
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const name = fileNameFromUrl(finalUrl.toString(), contentType);
  const image = contentType.startsWith("image/") || IMAGE_EXTENSIONS.test(name);
  const video = contentType.startsWith("video/") || VIDEO_EXTENSIONS.test(name);
  const audio = contentType.startsWith("audio/") || AUDIO_EXTENSIONS.test(name);

  if (!image && !video && !audio) {
    await res.body?.cancel();
    return { kind: "link", url: finalUrl.toString(), name, contentType, size: 0 };
  }

  const limit = image ? MAX_IMAGE_BYTES : URL_FETCH_MAX_BYTES;
  const tooLarge = image
    ? `画像が大きすぎます (上限 ${formatBytes(MAX_IMAGE_BYTES)})`
    : `URL のファイルが大きすぎます (上限 ${formatBytes(URL_FETCH_MAX_BYTES)})`;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel();
    throw new Error(tooLarge);
  }
  const bytes = await readBody(res, limit, tooLarge);

  if (image) {
    if (!sniffImageType(bytes)) return { kind: "link", url: finalUrl.toString(), name, contentType, size: 0 };
    const size = imageSize(bytes);
    if (!size || size.width <= 0 || size.height <= 0) {
      return { kind: "link", url: finalUrl.toString(), name, contentType, size: 0 };
    }
    const scale = IMAGE_LONG_EDGE / Math.max(size.width, size.height);
    const width = size.width * scale;
    const height = size.height * scale;
    if (Math.min(width, height) < MIN_OBJECT_SIZE) {
      return { kind: "link", url: finalUrl.toString(), name, contentType, size: 0 };
    }
    return { kind: "image", url: finalUrl.toString(), name, contentType, size: bytes.length, bytes, width, height };
  }

  return {
    kind: video ? "video" : "audio",
    url: finalUrl.toString(),
    name,
    contentType,
    size: bytes.length,
    bytes,
  };
}

/** URL を取得する。画像・動画・音声は本文も返し、それ以外はリンクとして返す。 */
export async function fetchUrl(input: string): Promise<FetchedUrl> {
  let current = await assertPublicUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "vr-sns-prototype/1.0", accept: "*/*" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) throw new Error("リダイレクト先がありません");
        if (redirects === MAX_REDIRECTS) throw new Error("リダイレクトが多すぎます");
        current = await assertPublicUrl(new URL(location, current).toString());
        continue;
      }
      if (!res.ok) throw new Error(`URL を取得できませんでした (HTTP ${res.status})`);
      return await readMedia(res, current);
    }
    throw new Error("リダイレクトが多すぎます");
  } catch (err) {
    if (controller.signal.aborted) throw new Error("URL の取得がタイムアウトしました");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
