import { useEffect, useMemo } from "react";
import { CanvasTexture, DoubleSide, SRGBColorSpace } from "three";
import { FILE_ICON_HEIGHT, FILE_ICON_WIDTH, type LinkObject } from "@proto/protocol";
import { drawLinkIcon } from "./linkIcon";
import { ObjectFrame } from "./ObjectFrame";

/**
 * URL のリンク。URL を書いたカードを 3D 空間に置く。
 * 中身は持たず、リングメニューの「ブラウザで開く」で、ブラウザの別タブで開く。
 */
export function LinkPlane({ object }: { object: LinkObject }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    drawLinkIcon(canvas, object.url);
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    result.anisotropy = 8;
    return result;
  }, [object.url]);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <ObjectFrame object={object} width={FILE_ICON_WIDTH} height={FILE_ICON_HEIGHT}>
      <meshBasicMaterial map={texture} transparent alphaTest={0.02} side={DoubleSide} toneMapped={false} />
    </ObjectFrame>
  );
}
