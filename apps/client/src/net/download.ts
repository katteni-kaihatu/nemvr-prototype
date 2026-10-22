import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  formatBytes,
  imageExtension,
  sanitizeFileName,
  type WorldObject,
} from "@proto/protocol";
import { requestStored, showLog, showNotice, updateDownload, useNet } from "./connection";
import { fetchBlob, isServing, summarizeSources, type FetchSource } from "./ipfs";

const PROGRESS_INTERVAL_MS = 300;
/**
 * サーバーがまだ保持していないファイルは、先に、いま繋がっている相手 (置いた人など) から直接取得を試す。
 * データがこの時間届かなければ、サーバーに取得させて (request_file)、保持されるのを待つ方へ切り替える。
 */
const DIRECT_TRY_IDLE_MS = 8_000;

/** ダウンロード中のオブジェクト (同じものを二重に始めない)。 */
const downloading = new Set<string>();

/**
 * 保存するファイル名。サーバーが整えた名前を、念のためもう一度整える。
 * 名前の無い画像 (古い配置など) は、CID と画像の形式から付ける。
 */
export function downloadName(object: Exclude<WorldObject, { kind: "box" | "link" }>, head?: Uint8Array): string {
  if (object.name) return sanitizeFileName(object.name, "download");
  const extension = head ? imageExtension(head) : "";
  return `image-${object.cid.slice(-8)}${extension ? `.${extension}` : ""}`;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name; // ページを開かず、保存する
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 保存の開始に十分な時間を置いてから解放する
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** ブロックの取得元の内訳を、HUD 用の文字列にする。 */
export function describeSources(sources: FetchSource[]): string {
  if (sources.length === 0) return "(取得元の記録なし)";
  return sources.map((s) => `${s.label} ${s.blocks} ブロック`).join(" / ");
}

/** 直近のダウンロードの結果 (開発時のみ、E2E テストから確認できるようにする)。 */
export interface DownloadReport {
  name: string;
  size: number;
  sources: FetchSource[];
  /** 先に直接取得を試して、だめだったので、サーバーに取得させて待った */
  usedFallback: boolean;
}
if (import.meta.env.DEV) {
  (window as unknown as { __downloadReports: DownloadReport[] }).__downloadReports = [];
}

export interface ObjectBlobOptions {
  /** 取得したバイト数 (と、全体のバイト数。分からなければ undefined) */
  onProgress?: (loaded: number, total?: number) => void;
  /** 「準備中」などの状態 (HUD に出す) */
  onStatus?: (message: string) => void;
  /** 中断 (動画の画面を閉じたときなど) */
  signal?: AbortSignal;
}

export interface ObjectBlob {
  blob: Blob;
  /** ブロックの取得元の内訳 */
  sources: FetchSource[];
  /** 先に直接取得を試して、だめだったので、サーバーに取得させて待った */
  usedFallback: boolean;
}

/**
 * オブジェクトの中身を IPFS から取得して Blob にする (ダウンロードと、動画の再生で共通)。
 *
 * サーバーがまだ保持していない大きなファイル (置いた直後で、サーバーが取得している途中) は、
 * 先に、繋がっている相手から直接の取得を試す。データが届かない・失敗したときは、
 * サーバーに取得の完了を待たせて (request_file)、そのあとで取得し直す。
 */
export async function fetchObjectBlob(
  object: Exclude<WorldObject, { kind: "box" | "link" }>,
  { onProgress, onStatus, signal }: ObjectBlobOptions = {},
): Promise<ObjectBlob> {
  const counts = new Map<string, number>();
  let usedFallback = false;
  const maxBytes = object.kind === "file" ? MAX_FILE_BYTES : MAX_IMAGE_BYTES;
  const total = object.kind === "file" ? object.size : undefined;
  const label = object.kind === "file" ? object.name : "画像";
  const fetchOnce = (idleTimeoutMs?: number) => {
    counts.clear();
    return fetchBlob(object.cid, {
      maxBytes,
      idleTimeoutMs,
      signal,
      onSource: (peer) => counts.set(peer, (counts.get(peer) ?? 0) + 1),
      onProgress: (loaded) => onProgress?.(loaded, total),
    });
  };
  /** サーバーがまだ保持していない (置いた直後などで、取得している途中の) ファイルか。自分が配っているなら、そのまま取れる。 */
  const notStoredYet = () => {
    const latest = useNet.getState().objects[object.id];
    return object.kind === "file" && !!latest && latest.kind === "file" && !latest.stored && !isServing(object.cid);
  };

  let blob: Blob;
  if (!notStoredYet()) {
    blob = await fetchOnce();
  } else {
    try {
      // 開発時のみ: E2E テストから、直接の取得が失敗した場合 (サーバーに取得させて待つ方) を試せるようにする
      if (import.meta.env.DEV && (window as unknown as { __forceDownloadFallback?: boolean }).__forceDownloadFallback) {
        throw new Error("直接の取得を失敗させた (テスト)");
      }
      blob = await fetchOnce(DIRECT_TRY_IDLE_MS); // 先に、繋がっている相手から直接
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn("[download] direct fetch failed; asking the server to fetch it first:", err);
      usedFallback = true;
      const latest = useNet.getState().objects[object.id];
      if (!latest) throw new Error("ファイルは削除されました");
      if (latest.kind === "file" && !latest.stored) {
        if (latest.offline) throw new Error("アップロードした人が退室しているため、取得できません");
        onStatus?.(`${label}: ダウンロードの準備 (サーバーが、置いた人から取得しています)`);
        await requestStored(latest);
      }
      blob = await fetchOnce();
    }
  }
  return { blob, sources: summarizeSources(counts), usedFallback };
}

/**
 * オブジェクトの中身を IPFS から取得して、ファイルとして保存する (ブラウザのダウンロード)。
 * 進捗と結果、ブロックの取得元の内訳は HUD に表示する。
 */
export async function downloadObject(object: WorldObject): Promise<void> {
  if (object.kind === "box" || object.kind === "link") return; // ボックス・リンクはダウンロードできない
  if (downloading.has(object.id)) {
    console.warn(`[download] already downloading ${object.id}`);
    return;
  }
  downloading.add(object.id);

  const label = downloadName(object);
  updateDownload(object.id, {
    label,
    loaded: 0,
    total: object.kind === "file" ? object.size : undefined,
    status: "取得中",
    startedAt: Date.now(),
  });
  let lastNoticeAt = 0;
  try {
    showNotice(`ダウンロード中: ${label}`, 60_000);
    const { blob, sources, usedFallback } = await fetchObjectBlob(object, {
      onStatus: (message) => {
        updateDownload(object.id, { status: message });
        showNotice(message, 60_000);
      },
      onProgress: (loaded, total) => {
        updateDownload(object.id, { loaded, total });
        const now = performance.now();
        if (now - lastNoticeAt < PROGRESS_INTERVAL_MS) return;
        lastNoticeAt = now;
        const progress = total ? `${Math.min(100, Math.floor((loaded / total) * 100))}% (${formatBytes(loaded)} / ${formatBytes(total)})` : formatBytes(loaded);
        showNotice(`ダウンロード中: ${label} ${progress}`, 60_000);
      },
    });

    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const name = downloadName(object, head);
    saveBlob(blob, name);
    console.info(`[download] ${name} (${formatBytes(blob.size)}) from: ${describeSources(sources)}${usedFallback ? " (after fallback to request_file)" : ""}`);
    const sourceText = `取得元: ${describeSources(sources)}${usedFallback ? " (request_file 後)" : ""}`;
    showLog(`ダウンロード完了: ${name} (${formatBytes(blob.size)}) / ${sourceText}`);
    showNotice(`ダウンロードしました: ${name} (${formatBytes(blob.size)}) / ${sourceText}`, 10_000);
    if (import.meta.env.DEV) {
      (window as unknown as { __downloadReports: DownloadReport[] }).__downloadReports.push({ name, size: blob.size, sources, usedFallback });
    }
  } catch (err) {
    console.warn(`[download] failed: ${err instanceof Error ? err.message : String(err)}`, err);
    showLog(`ダウンロード失敗: ${label}${err instanceof Error ? ` (${err.message})` : ""}`);
    showNotice(`ダウンロードに失敗しました: ${label}${err instanceof Error ? ` (${err.message})` : ""}`, 8000);
  } finally {
    updateDownload(object.id, null);
    downloading.delete(object.id);
  }
}
