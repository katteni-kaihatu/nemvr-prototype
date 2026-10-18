import { useEffect, useMemo, type RefObject } from "react";
import { CanvasTexture, SRGBColorSpace, type Group } from "three";

export const EYE_HEIGHT = 1.6;

interface AvatarProps {
  color: string;
  name: string;
  /** 足元のワールド位置を受け持つグループ */
  rootRef: RefObject<Group | null>;
  /** 頭の向きを受け持つグループ (前方は -Z) */
  headRef: RefObject<Group | null>;
}

/** 簡易アバター。将来 glTF / VRM に差し替える際はこのコンポーネントに閉じ込める。 */
export function Avatar({ color, name, rootRef, headRef }: AvatarProps) {
  return (
    <group ref={rootRef}>
      <mesh position={[0, 0.7, 0]}>
        <capsuleGeometry args={[0.25, 0.9, 4, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <group ref={headRef} position={[0, EYE_HEIGHT, 0]}>
        <mesh>
          <sphereGeometry args={[0.16, 24, 16]} />
          <meshStandardMaterial color={color} />
        </mesh>
        {/* 目: 前方 (-Z) を示す */}
        <mesh position={[-0.06, 0.03, -0.14]}>
          <sphereGeometry args={[0.03, 8, 8]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        <mesh position={[0.06, 0.03, -0.14]}>
          <sphereGeometry args={[0.03, 8, 8]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      </group>
      <NameTag name={name} />
    </group>
  );
}

const TAG_HEIGHT = 0.3; // ワールド上の高さ (m)

/**
 * 名前タグ。2D canvas に描いたテクスチャを Sprite (常にカメラを向く) で表示する。
 * drei の Html は Canvas の初回レンダーと同時にマウントされると
 * タグが消えることがあったため使わない。
 */
function NameTag({ name }: { name: string }) {
  const { texture, aspect } = useMemo(() => {
    const font = "bold 48px system-ui, sans-serif";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = font;
    const h = 72;
    const w = Math.ceil(ctx.measureText(name).width) + 40;
    canvas.width = w; // リサイズで描画状態がリセットされる
    canvas.height = h;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 16);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, w / 2, h / 2 + 3);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return { texture, aspect: w / h };
  }, [name]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite position={[0, EYE_HEIGHT + 0.35, 0]} scale={[TAG_HEIGHT * aspect, TAG_HEIGHT, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </sprite>
  );
}
