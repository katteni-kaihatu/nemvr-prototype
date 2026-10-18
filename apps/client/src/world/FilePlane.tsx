import { useEffect, useMemo } from "react";
import { CanvasTexture, DoubleSide, SRGBColorSpace } from "three";
import { FILE_ICON_HEIGHT, FILE_ICON_WIDTH, type FileObject } from "@proto/protocol";
import { drawFileIcon } from "./fileIcon";
import { ObjectFrame } from "./ObjectFrame";

/**
 * ワールドに置かれたファイル。ファイルの形のアイコン (音声・映像は専用の絵柄) の板で、
 * 名前とサイズを表示する。ファイルの中身は、ダウンロードするときに初めて取得する。
 */
export function FilePlane({ object }: { object: FileObject }) {
  const { name, size, category, offline } = object;

  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    drawFileIcon(canvas, { name, size, category, offline });
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [name, size, category, offline]);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <ObjectFrame object={object} width={FILE_ICON_WIDTH} height={FILE_ICON_HEIGHT}>
      {/* ページの外側は透明。角や欄の外を抜く */}
      <meshBasicMaterial map={texture} transparent alphaTest={0.02} side={DoubleSide} toneMapped={false} />
    </ObjectFrame>
  );
}
