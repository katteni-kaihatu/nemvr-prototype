import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Plane, Raycaster, Vector2, Vector3, type Camera } from "three";
import { MAX_IMAGE_BYTES, MIN_OBJECT_SIZE } from "@proto/protocol";
import { sendPlaceImage, showNotice, useNet } from "../net/connection";
import { addImage } from "../net/ipfs";

const IMAGE_LONG_EDGE = 2.5; // 置く画像の長辺 (m)
const GAP = 0.3; // 複数枚を同時に置くときの間隔 (m)
const MAX_PLACE_DISTANCE = 20; // これより遠い地点は使わず、正面に置く
const FALLBACK_DISTANCE = 4;
const WORLD_HALF_SIZE = 24;

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

interface Prepared {
  file: File;
  width: number;
  height: number;
}

async function prepare(file: File): Promise<Prepared | null> {
  if (file.size > MAX_IMAGE_BYTES) {
    showNotice(`${file.name}: 画像が大きすぎます (上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`);
    return null;
  }
  let w: number;
  let h: number;
  try {
    const bitmap = await createImageBitmap(file);
    w = bitmap.width;
    h = bitmap.height;
    bitmap.close();
  } catch {
    showNotice(`${file.name}: 画像として読み込めません`);
    return null;
  }
  const scale = IMAGE_LONG_EDGE / Math.max(w, h);
  const width = w * scale;
  const height = h * scale;
  if (Math.min(width, height) < MIN_OBJECT_SIZE) {
    showNotice(`${file.name}: 縦横比が極端なため置けません`);
    return null;
  }
  return { file, width, height };
}

/** ドロップされた画像を IPFS に追加し、ドロップ地点に (複数なら横並びで) 置く。 */
async function placeFiles(files: File[], point: Vector3, from: Vector3): Promise<void> {
  const prepared = (await Promise.all(files.map(prepare))).filter((p): p is Prepared => p !== null);
  if (prepared.length === 0) return;

  // 置いた人の方を向かせる。+X 方向 (right) は yaw 回転後のローカル +X。
  const yaw = Math.atan2(from.x - point.x, from.z - point.z);
  const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const total = prepared.reduce((sum, p) => sum + p.width, 0) + GAP * (prepared.length - 1);
  let cursor = -total / 2;

  showNotice("画像を IPFS に追加中...");
  for (const p of prepared) {
    const center = point.clone().addScaledVector(right, cursor + p.width / 2);
    cursor += p.width + GAP;
    try {
      const cid = await addImage(p.file);
      sendPlaceImage({
        cid,
        position: [center.x, 0, center.z],
        yaw,
        width: p.width,
        height: p.height,
      });
    } catch (e) {
      showNotice(e instanceof Error ? e.message : "画像を IPFS に追加できませんでした");
      return;
    }
  }
  useNet.setState({ notice: null });
}

/** 画像ファイルのドラッグ&ドロップを受け付ける (描画なし)。 */
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
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) {
        showNotice("画像ファイルをドロップしてください");
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

  return null;
}
