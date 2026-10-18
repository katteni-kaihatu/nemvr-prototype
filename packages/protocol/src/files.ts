// ファイルオブジェクトに関する共有ロジック。純粋関数のみで、実行時依存はない。

export type FileCategory = "audio" | "video" | "file";

/** 3D 空間に置くファイルアイコンの大きさ (m)。下辺中央が position。名前とサイズの表示欄を含む。 */
export const FILE_ICON_WIDTH = 0.9;
export const FILE_ICON_HEIGHT = 1.2;
/** ファイルアイコンを床から浮かせる高さ (m)。 */
export const FILE_FLOAT_HEIGHT = 0.6;

export const MAX_FILE_NAME_LENGTH = 120;

const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "ogg", "oga", "opus", "flac", "aac", "m4a", "m4b", "wma", "aif", "aiff", "mid", "midi", "weba", "amr", "ape",
]);

// "ts" は TypeScript と紛らわしいので含めない
const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "avi", "wmv", "flv", "ogv", "mpg", "mpeg", "3gp", "m2ts", "vob",
]);

/** 拡張子 (小文字、ドットなし)。無い・不自然な場合は空文字。 */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  // ".gitignore" のような先頭のドットは拡張子ではない。"name." のような末尾のドットも
  if (i <= 0 || i === name.length - 1) return "";
  const ext = name.slice(i + 1).toLowerCase();
  return /^[a-z0-9_+-]{1,10}$/.test(ext) ? ext : "";
}

/**
 * ダウンロード時のファイル名として安全な形にする。
 * - 制御文字、ゼロ幅文字、書字方向を変える文字 (拡張子の偽装に使われる) を除く
 * - パス区切りや、多くの OS で使えない文字を `_` にする
 * - 先頭のドットと、末尾のドット・空白を除く
 * - 長すぎる場合は、拡張子を残して切り詰める
 */
export function sanitizeFileName(raw: unknown, fallback = "file"): string {
  if (typeof raw !== "string") return fallback;
  let name = raw
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[ .]+$/, "");
  if (name === "") return fallback;

  const chars = [...name]; // サロゲートペアの途中で切らないよう、コードポイント単位で数える
  if (chars.length > MAX_FILE_NAME_LENGTH) {
    const ext = extensionOf(name);
    const suffix = ext ? `.${ext}` : "";
    name = chars.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - suffix.length)).join("") + suffix;
  }
  return name;
}

const startsWith = (b: Uint8Array, bytes: number[], offset = 0) =>
  b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * 先頭バイトから、音声・映像の代表的なコンテナを判定する (拡張子で決まらないときの補助)。
 * 判定できなければ "file"。
 */
export function sniffMediaKind(head: Uint8Array): FileCategory {
  // 映像
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return "video"; // Matroska / WebM
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("AVI "), 8)) return "video";
  if (startsWith(head, ascii("ftyp"), 4)) {
    // ISO Base Media (MP4 / MOV / M4A)。ブランドが M4A / M4B / F4A なら音声
    const brand = String.fromCharCode(...head.slice(8, 12));
    return /^(M4A |M4B |F4A )$/.test(brand) ? "audio" : "video";
  }
  // 音声
  if (startsWith(head, ascii("ID3"))) return "audio"; // MP3 (ID3 タグ付き)
  if (head.length >= 2 && head[0] === 0xff && [0xfb, 0xfa, 0xf3, 0xf2].includes(head[1]!)) return "audio"; // MP3 フレーム
  if (head.length >= 2 && head[0] === 0xff && (head[1] === 0xf1 || head[1] === 0xf9)) return "audio"; // AAC (ADTS)
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WAVE"), 8)) return "audio";
  if (startsWith(head, ascii("OggS"))) return "audio";
  if (startsWith(head, ascii("fLaC"))) return "audio";
  if (startsWith(head, ascii("FORM")) && startsWith(head, ascii("AIFF"), 8)) return "audio";
  if (startsWith(head, ascii("MThd"))) return "audio"; // MIDI
  return "file";
}

/**
 * ファイルの種類 (アイコンの種類)。拡張子で判定し、拡張子が未知・無い場合だけ先頭バイトで補う。
 * 拡張子は申告なので、判定は表示 (アイコン) にしか使わない。
 */
export function classifyFile(name: string, head?: Uint8Array): FileCategory {
  const ext = extensionOf(name);
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return head ? sniffMediaKind(head) : "file";
}

/**
 * 画像の先頭バイトから、保存するときの拡張子を決める (PNG / JPEG / GIF / WebP)。
 * 判定できなければ空文字。
 */
export function imageExtension(head: Uint8Array): string {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "gif";
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "webp";
  return "";
}

/** アイコンに描く拡張子のラベル (大文字、最大 4 文字)。拡張子が無ければ "FILE"。 */
export function iconLabel(name: string): string {
  const ext = extensionOf(name);
  return ext ? ext.toUpperCase().slice(0, 4) : "FILE";
}

/** 人が読みやすいサイズ表記 (1024 区切り)。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}
