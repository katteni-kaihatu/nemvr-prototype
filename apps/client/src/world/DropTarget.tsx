import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Plane, Raycaster, Vector2, Vector3, type Camera } from "three";
import {
  FILE_FLOAT_HEIGHT,
  FILE_ICON_HEIGHT,
  FILE_ICON_WIDTH,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_URL_LENGTH,
  MIN_OBJECT_SIZE,
  formatBytes,
} from "@proto/protocol";
import { expectUpload, sendPlaceFile, sendPlaceImage, sendPlaceUrl, showNotice } from "../net/connection";
import { addContent, uploadImage } from "../net/ipfs";
import { isPasteShortcut, shouldHandlePaste } from "./pasteShortcut";

const IMAGE_LONG_EDGE = 2.5; // 置く画像の長辺 (m)
const GAP = 0.3; // 複数枚を同時に置くときの間隔 (m)
const PROGRESS_NOTICE_BYTES = 8 * 1024 * 1024; // これより大きいファイルは、追加の進捗を表示する
const PROGRESS_INTERVAL_MS = 300;
const MAX_PLACE_DISTANCE = 20; // これより遠い地点は使わず、正面に置く
const FALLBACK_DISTANCE = 4;
const WORLD_HALF_SIZE = 24;

/** サーバーが画像として扱える形式。これ以外 (SVG など) の画像ファイルは、ファイルとして置く。 */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const FLOOR = new Plane(new Vector3(0, 1, 0), 0);

/** ドロップ位置から視線を飛ばして床との交点を求める。当たらなければ正面の床。 */
function resolveDropPoint(
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): Vector3 {
  const rect = canvas.getBoundingClientRect();
  const ndc = new Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  camera.updateMatrixWorld();
  const raycaster = new Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectPlane(FLOOR, new Vector3());
  let point: Vector3;
  if (hit && hit.distanceTo(camera.position) <= MAX_PLACE_DISTANCE) {
    point = hit;
  } else {
    const dir = camera.getWorldDirection(new Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    point = camera.position.clone().addScaledVector(dir.normalize(), FALLBACK_DISTANCE);
  }
  point.y = 0;
  point.x = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, point.x));
  point.z = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, point.z));
  return point;
}

type Prepared =
  | { kind: "image"; file: File; width: number; height: number }
  | { kind: "file"; file: File; width: number; height: number };

/** 画像として表示できるなら、大きさを決めて返す。できなければ null (ファイルとして置く)。 */
async function prepareImage(file: File): Promise<Prepared | null> {
  if (!IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) return null;
  let w: number;
  let h: number;
  try {
    const bitmap = await createImageBitmap(file);
    w = bitmap.width;
    h = bitmap.height;
    bitmap.close();
  } catch {
    return null;
  }
  const scale = IMAGE_LONG_EDGE / Math.max(w, h);
  const width = w * scale;
  const height = h * scale;
  if (Math.min(width, height) < MIN_OBJECT_SIZE) return null; // 極端な縦横比
  return { kind: "image", file, width, height };
}

/**
 * ドロップされたファイルを、画像 (板) かファイル (アイコン) かに振り分ける。
 * 画像として表示できるもの (PNG / JPEG / GIF / WebP で、5MB 以下、読み込める) だけが画像で、
 * それ以外はすべてファイルとして置く。置けないもの (大きすぎる) は null。
 */
async function prepare(file: File): Promise<Prepared | null> {
  if (file.size > MAX_FILE_BYTES) {
    showNotice(`${file.name}: ファイルが大きすぎます (上限 ${formatBytes(MAX_FILE_BYTES)})`);
    return null;
  }
  return (await prepareImage(file)) ?? { kind: "file", file, width: FILE_ICON_WIDTH, height: FILE_ICON_HEIGHT };
}

/** ドロップされたものを IPFS に追加し、ドロップ地点に (複数なら横並びで) 置く。 */
async function placeFiles(files: File[], point: Vector3, from: Vector3): Promise<void> {
  const prepared = (await Promise.all(files.map(prepare))).filter((p): p is Prepared => p !== null);
  if (prepared.length === 0) return;

  // 置いた人の方を向かせる。+X 方向 (right) は yaw 回転後のローカル +X。
  const yaw = Math.atan2(from.x - point.x, from.z - point.z);
  const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const total = prepared.reduce((sum, p) => sum + p.width, 0) + GAP * (prepared.length - 1);
  let cursor = -total / 2;

  showNotice("IPFS に追加中...");
  for (const p of prepared) {
    const center = point.clone().addScaledVector(right, cursor + p.width / 2);
    cursor += p.width + GAP;
    try {
      // 画像はサーバーへ直接アップロードして pin してもらう。こうすると、
      // 置いた人のブラウザの IPFS 接続に依存せず、他の人にも表示できる。
      let cid: string;
      if (p.kind === "image") {
        showNotice(`${p.file.name}: アップロード中...`, 8000);
        cid = await uploadImage(p.file);
      } else {
        // 大きなファイルは、ブラウザ内の IPFS ノードへ追加するだけでも時間がかかるので、進捗を表示する
        let lastNoticeAt = 0;
        cid = await addContent(p.file, {
          onProgress: (loaded, total) => {
            const now = performance.now();
            if (total < PROGRESS_NOTICE_BYTES || now - lastNoticeAt < PROGRESS_INTERVAL_MS) return;
            lastNoticeAt = now;
            showNotice(`${p.file.name}: IPFS に追加中 ${Math.floor((loaded / total) * 100)}%`, 8000);
          },
        });
      }
      expectUpload(cid, p.file.name); // サーバーからの転送の進捗に、ファイル名を付ける
      if (p.kind === "image") {
        sendPlaceImage({
          cid,
          position: [center.x, 0, center.z],
          yaw,
          width: p.width,
          height: p.height,
          name: p.file.name,
        });
      } else {
        // ファイルのアイコンは床から少し浮かせる。種類 (アイコン) とサイズは、サーバーが中身から決める
        sendPlaceFile({ cid, name: p.file.name, position: [center.x, FILE_FLOAT_HEIGHT, center.z], yaw });
      }
      // (ここで通知は出さない。サーバーからの進捗や、置けたときの案内が、後から出るので、上書きしてしまう)
    } catch (e) {
      showNotice(e instanceof Error ? e.message : "IPFS に追加できませんでした");
      return;
    }
  }
}

/** ファイル (画像を含む) のドラッグ&ドロップを受け付ける (描画なし)。 */
export function DropTarget() {
  const camera = useThree((s) => s.camera);
  const canvas = useThree((s) => s.gl.domElement);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

    // canvas 以外にドロップしてもブラウザが画像を開いてページ遷移しないようにする
    const swallow = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      // フォルダは置けない (中身を読めない)。イベントの中で、フォルダかどうかを調べておく
      const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === "file");
      const dropped = items.length
        ? items.map((i) => ({ file: i.getAsFile(), directory: i.webkitGetAsEntry?.()?.isDirectory === true }))
        : [...(e.dataTransfer?.files ?? [])].map((file) => ({ file, directory: false }));
      if (dropped.some((d) => d.directory)) showNotice("フォルダは置けません。ファイルをドロップしてください");
      const files = dropped.flatMap((d) => (d.file && !d.directory ? [d.file] : []));
      if (files.length === 0) {
        if (!dropped.some((d) => d.directory)) showNotice("ファイルをドロップしてください");
        return;
      }
      const point = resolveDropPoint(camera, canvas, e.clientX, e.clientY);
      void placeFiles(files, point, camera.position.clone());
    };

    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    canvas.addEventListener("dragover", onDragOver);
    canvas.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
      canvas.removeEventListener("dragover", onDragOver);
      canvas.removeEventListener("drop", onDrop);
    };
  }, [camera, canvas]);

  // Ctrl+V で http(s) の URL を貼ると、その URL を取得して置く (サーバーが取得するので CORS の影響を受けない)
  useEffect(() => {
    // 中ボタン貼り付け (Linux の primary selection) でも paste が発火するため、
    // 直前の Ctrl+V / Cmd+V と対応する貼り付けだけを URL 配置として扱う。
    let pasteShortcutAt = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isPasteShortcut(e)) pasteShortcutAt = performance.now();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isPasteShortcut(e)) pasteShortcutAt = 0;
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!shouldHandlePaste(pasteShortcutAt, performance.now())) return;
      pasteShortcutAt = 0;
      const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (!/^https?:\/\//i.test(text)) return; // URL 以外の貼り付けは、そのまま
      if (text.length > MAX_URL_LENGTH) {
        e.preventDefault();
        showNotice(`URL が長すぎます (${MAX_URL_LENGTH} 文字まで)`);
        return;
      }
      e.preventDefault();
      const point = resolveDropPoint(camera, canvas, canvas.clientWidth / 2, canvas.clientHeight / 2);
      const from = camera.position;
      const yaw = Math.atan2(from.x - point.x, from.z - point.z);
      sendPlaceUrl(text, [point.x, 0, point.z], yaw);
      showNotice(`URL を取得中... ${text.length > 70 ? `${text.slice(0, 70)}...` : text}`, 60000);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, [camera, canvas]);

  return null;
}
