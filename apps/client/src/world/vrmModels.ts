import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { MAX_AVATAR_BYTES } from "@proto/protocol";
import { fetchBlob } from "../net/ipfs";
import { RefCountedCache } from "./refCountedCache";

/**
 * 同じ CID の VRM を何度もダウンロードしないためのキャッシュ。
 * バイト列 (ArrayBuffer) だけを共有し、VRM インスタンスは呼び出しごとに作り直す
 * (three.js のオブジェクトは、複数のピアで共有できない)。
 *
 * 参照カウントで管理し、その CID を見ている人がいなくなったら捨てる
 * (退出したユーザーのアバターを、他のクライアントに残さない)。
 */
const vrmBuffers = new RefCountedCache<ArrayBuffer>((cid, signal) =>
  fetchBlob(cid, { maxBytes: MAX_AVATAR_BYTES, signal }).then((blob) => blob.arrayBuffer()),
);

if (import.meta.env.DEV) {
  // 開発時のみ: E2E から、保持している VRM の CID を確認できるようにする
  (window as unknown as { __vrmModels: unknown }).__vrmModels = {
    cached: () => vrmBuffers.keys(),
  };
}

/** この CID の表示をやめた (参照を 1 つ減らす)。最後の 1 人なら、取得中の読み込みも取り消して捨てる。 */
export function releaseVrm(cid: string): void {
  vrmBuffers.release(cid);
}

/** IPFS から VRM を取得して読み込む。失敗したら例外を投げる (呼び出し側は簡易アバターに戻す)。 */
export async function loadVrm(cid: string): Promise<VRM> {
  // 参照を 1 つ増やす。表示をやめるときは、必ず releaseVrm を呼ぶこと
  const data = await vrmBuffers.acquire(cid);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await new Promise<GLTF>((resolve, reject) => {
    loader.parse(data, "", resolve, reject);
  });

  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("VRM ではありません");

  // VRM 0.x は -Z 向きなので、1.0 と同じ +Z 向きにそろえる
  VRMUtils.rotateVRM0(vrm);

  // スキンメッシュは、バウンディングボックスが実際の姿勢と合わず、視界の端で消えることがある
  vrm.scene.traverse((object) => {
    if ((object as { isSkinnedMesh?: boolean }).isSkinnedMesh) object.frustumCulled = false;
  });

  // 使われていない頂点を削る (モーフ用テクスチャの VRAM を節約する)。失敗しても読み込みは続ける
  try {
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
  } catch (err) {
    console.warn("[vrm] removeUnnecessaryVertices failed:", err);
  }

  vrm.scene.updateMatrixWorld(true);
  return vrm;
}
