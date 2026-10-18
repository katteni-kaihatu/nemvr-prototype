import { useEffect, useState } from "react";
import { DoubleSide, SRGBColorSpace, TextureLoader, type Texture } from "three";
import type { ImageObject } from "@proto/protocol";
import { getImageUrl } from "../net/ipfs";
import { ObjectFrame } from "./ObjectFrame";

/**
 * CID の画像を IPFS から取得してテクスチャにする。
 * 取得前・失敗時は null (例外は投げない)。
 */
function useImageTexture(cid: string): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let disposed = false;
    let loaded: Texture | null = null;
    getImageUrl(cid)
      .then(
        (url) =>
          new Promise<Texture>((resolve, reject) => {
            new TextureLoader().load(url, resolve, undefined, () => reject(new Error("decode failed")));
          }),
      )
      .then((t) => {
        if (disposed) {
          t.dispose();
          return;
        }
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = 8;
        loaded = t;
        setTexture(t);
      })
      .catch((err: unknown) => {
        // 取得失敗時はプレースホルダーのままにする
        console.warn(`[image] ${cid}:`, err);
      });
    return () => {
      disposed = true;
      loaded?.dispose();
    };
  }, [cid]);

  return texture;
}

/** ワールドに置かれた画像。鉛直な板で、画像は CID から IPFS で取得してテクスチャにする。 */
export function ImagePlane({ object }: { object: ImageObject }) {
  const texture = useImageTexture(object.cid);
  return (
    <ObjectFrame object={object} width={object.width} height={object.height}>
      {/* map の有無でシェーダーが変わるため key で作り直す */}
      <meshBasicMaterial
        key={texture ? "loaded" : "placeholder"}
        map={texture}
        color={texture ? "#ffffff" : "#888888"}
        side={DoubleSide}
        toneMapped={false}
      />
    </ObjectFrame>
  );
}
