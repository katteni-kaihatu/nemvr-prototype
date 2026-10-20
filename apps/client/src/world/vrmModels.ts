import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { MAX_AVATAR_BYTES } from "@proto/protocol";
import { fetchBlob } from "../net/ipfs";

/**
 * 同じ CID の VRM を何度もダウンロードしないためのキャッシュ。
 * バイト列 (ArrayBuffer) だけを共有し、VRM インスタンスは呼び出しごとに作り直す
 * (three.js のオブジェクトは、複数のピアで共有できない)。
 */
const buffers = new Map<string, Promise<ArrayBuffer>>();

function fetchVrmBuffer(cid: string): Promise<ArrayBuffer> {
  let pending = buffers.get(cid);
  if (!pending) {
    pending = fetchBlob(cid, { maxBytes: MAX_AVATAR_BYTES }).then((blob) => blob.arrayBuffer());
    buffers.set(cid, pending);
    // 失敗はキャッシュしない (次に呼ばれたら、やり直せるようにする)
    pending.catch(() => {
      if (buffers.get(cid) === pending) buffers.delete(cid);
    });
  }
  return pending;
}

/** IPFS から VRM を取得して読み込む。失敗したら例外を投げる (呼び出し側は簡易アバターに戻す)。 */
export async function loadVrm(cid: string): Promise<VRM> {
  const data = await fetchVrmBuffer(cid);

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
