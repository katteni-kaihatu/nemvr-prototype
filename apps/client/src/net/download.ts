import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  formatBytes,
  imageExtension,
  sanitizeFileName,
  type WorldObject,
} from "@proto/protocol";
import { showNotice } from "./connection";
import { fetchBlob } from "./ipfs";

const PROGRESS_INTERVAL_MS = 300;

/** ダウンロード中のオブジェクト (同じものを二重に始めない)。 */
const downloading = new Set<string>();

/**
 * 保存するファイル名。サーバーが整えた名前を、念のためもう一度整える。
 * 名前の無い画像 (古い配置など) は、CID と画像の形式から付ける。
 */
export function downloadName(object: WorldObject, head?: Uint8Array): string {
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

/**
 * オブジェクトの中身を IPFS から取得して、ファイルとして保存する (ブラウザのダウンロード)。
 * 進捗と結果は HUD に表示する。
 */
export async function downloadObject(object: WorldObject): Promise<void> {
  if (downloading.has(object.id)) return;
  downloading.add(object.id);

  const label = downloadName(object);
  const total = object.kind === "file" ? object.size : undefined;
  let lastNoticeAt = 0;
  showNotice(`ダウンロード中: ${label}`, 60_000);
  try {
    const blob = await fetchBlob(object.cid, {
      maxBytes: object.kind === "file" ? MAX_FILE_BYTES : MAX_IMAGE_BYTES,
      onProgress: (loaded) => {
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
    showNotice(`ダウンロードしました: ${name} (${formatBytes(blob.size)})`, 5000);
  } catch (err) {
    console.warn("[download] failed:", err);
    showNotice(`ダウンロードに失敗しました: ${label}${err instanceof Error ? ` (${err.message})` : ""}`, 8000);
  } finally {
    downloading.delete(object.id);
  }
}
