import { useEffect, useState } from "react";
import { DoubleSide, SRGBColorSpace, TextureLoader, type Texture } from "three";
import type { ImageObject } from "@proto/protocol";
import { imageUrl } from "../net/connection";

/** URL から画像テクスチャを読み込む。読み込み前・失敗時は null (例外は投げない)。 */
function useImageTexture(url: string): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let disposed = false;
    let loaded: Texture | null = null;
    new TextureLoader().load(
      url,
      (t) => {
        if (disposed) {
          t.dispose();
          return;
        }
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = 8;
        loaded = t;
        setTexture(t);
      },
      undefined,
      () => {
        // 読み込み失敗時はプレースホルダーのままにする
      },
    );
    return () => {
      disposed = true;
      loaded?.dispose();
    };
  }, [url]);

  return texture;
}

/** ワールドに置かれた画像。position は下辺中央、鉛直に立ち、法線は +Z を yaw 回したもの。 */
export function ImagePlane({ object }: { object: ImageObject }) {
  const texture = useImageTexture(imageUrl(object.imageId));
  return (
    <group position={object.position} rotation={[0, object.yaw, 0]}>
      <mesh position={[0, object.height / 2, 0]}>
        <planeGeometry args={[object.width, object.height]} />
        {/* map の有無でシェーダーが変わるため key で作り直す */}
        <meshBasicMaterial
          key={texture ? "loaded" : "placeholder"}
          map={texture}
          color={texture ? "#ffffff" : "#888888"}
          side={DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
