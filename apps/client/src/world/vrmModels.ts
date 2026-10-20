import { WebGLRenderTarget, type Camera, type Group, type Material, type Mesh, type Object3D, type Scene, type WebGLRenderer } from "three";
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

/** 続きを処理するまでに、メインスレッドを空ける間隔 (ms)。 */
const PARSE_SLICE_MS = 8;

/**
 * 次のフレームまで待つ。描画が挟まらないと、短い処理を続けただけで rAF が何百 ms も
 * 止まることがあるため、必ずフレームを待つ (非表示のタブでは、表示に戻るまで読み込みも待つ)。
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * GLTFLoader の解析を、少しずつメインスレッドに戻しながら進める。
 * 解析は 1 回の同期処理だと、大きな VRM で数秒フリーズするため、依存 (メッシュ・マテリアル・テクスチャ) を
 * 取るたびに、一定時間 (PARSE_SLICE_MS) を超えていたら次のフレームまで待つ。
 * GLTFLoader の内部メソッドを包むので、three.js の実装が変わったら見直すこと。
 */
function registerYieldPlugin(loader: GLTFLoader): void {
  loader.register((parser) => {
    const target = parser as unknown as {
      cache: { get(key: string): unknown };
      getDependency(type: string, index: number): Promise<unknown>;
    };
    const original = target.getDependency.bind(target);
    let lastYield = performance.now();
    target.getDependency = (type: string, index: number) => {
      // 取得済みのものは、そのまま返す (待つ必要はない)
      if (target.cache.get(`${type}:${index}`) !== undefined) return original(type, index);
      const value = () => Promise.resolve(original(type, index));
      if (performance.now() - lastYield < PARSE_SLICE_MS) return value();
      lastYield = performance.now();
      return yieldToMain().then(value);
    };
    return { name: "PROTO_YIELD" };
  });
}

/**
 * 最初の描画でまとめて起きるシェーダーのコンパイルを、表示前に少しずつ済ませる。
 * マテリアルごとに、そのメッシュだけを 1x1 の描画先へ実際に描いてコンパイルし、
 * 1 つごとにフレームを空ける。失敗しても読み込みは続ける。
 */
export async function prepareVrm(
  vrm: VRM,
  renderer: WebGLRenderer,
  camera: Camera,
  scene: Scene,
  group: Group,
  isCancelled: () => boolean,
): Promise<void> {
  const meshes: Mesh[] = [];
  vrm.scene.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    if (material) meshes.push(object as Mesh);
  });

  // マテリアルごとに 1 回ずつ、実際に描画してシェーダーをコンパイルする。
  // compileAsync / compile は、Firefox では結局まとめてコンパイルされ、数百 ms 止まる。
  const pairs: { mesh: Mesh; material: Material }[] = [];
  const seen = new Set<string>();
  for (const mesh of meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (seen.has(material.uuid)) continue;
      seen.add(material.uuid);
      pairs.push({ mesh, material });
    }
  }

  // 準備の描画では、この VRM と光源以外を隠す (鏡の反射や他のアバターを描かない。
  // プログラムの定義に影響する光源の数は、実際のシーンと合わせる)
  const inGroup = new Set<Object3D>();
  group.traverse((object) => inGroup.add(object));
  const outside: Object3D[] = [];
  scene.traverse((object) => {
    if (object !== scene && !inGroup.has(object) && (object as { isLight?: boolean }).isLight !== true) outside.push(object);
  });

  const meshState = meshes.map((mesh) => ({ mesh, visible: mesh.visible, culled: mesh.frustumCulled, material: mesh.material }));
  const target = new WebGLRenderTarget(1, 1);
  const previousTarget = renderer.getRenderTarget();
  // 自分の VRM は鏡の中だけのレイヤーにいるので、全レイヤーを見るカメラで描く
  const warmCamera = camera.clone();
  warmCamera.layers.enableAll();
  try {
    for (const { mesh, material } of pairs) {
      if (isCancelled()) return;
      const outsideVisible = outside.map((object) => ({ object, visible: object.visible }));
      try {
        for (const item of outsideVisible) item.object.visible = false;
        for (const item of meshes) item.visible = item === mesh;
        mesh.frustumCulled = false;
        mesh.material = material;
        group.visible = true;
        renderer.setRenderTarget(target);
        renderer.render(scene, warmCamera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        group.visible = false;
        for (const item of outsideVisible) item.object.visible = item.visible;
      }
      await yieldToMain();
    }
  } catch (err) {
    console.warn("[vrm] preparation failed:", err);
  } finally {
    renderer.setRenderTarget(previousTarget);
    target.dispose();
    for (const state of meshState) {
      state.mesh.visible = state.visible;
      state.mesh.frustumCulled = state.culled;
      state.mesh.material = state.material;
    }
  }
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
  registerYieldPlugin(loader);

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
