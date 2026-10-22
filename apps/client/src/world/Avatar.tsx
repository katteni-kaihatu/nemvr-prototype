import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Group, type Sprite } from "three";

import { NAMEPLATE_LAYER, NAMEPLATE_MIRROR_LAYER } from "./layers";

import { EYE_HEIGHT } from "./movement";

export { EYE_HEIGHT };

interface AvatarProps {
  color: string;
  name: string;
  /** 足元のワールド位置を受け持つグループ */
  rootRef: RefObject<Group | null>;
  /** 頭の向きを受け持つグループ (前方は -Z)。しゃがむと、位置 (高さ) が下がる。 */
  headRef: RefObject<Group | null>;
  /** 胴体のグループ。しゃがむと、縦に縮む。 */
  bodyRef: RefObject<Group | null>;
  /** 名前タグのグループ。しゃがむと、頭に合わせて下がる。 */
  tagRef: RefObject<Group | null>;
}

/** 簡易アバター。将来 glTF / VRM に差し替える際はこのコンポーネントに閉じ込める。 */
export function Avatar({ color, name, rootRef, headRef, bodyRef, tagRef }: AvatarProps) {
  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        <mesh position={[0, 0.7, 0]}>
          <capsuleGeometry args={[0.25, 0.9, 4, 12]} />
          <meshStandardMaterial color={color} />
        </mesh>
      </group>
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
      <group ref={tagRef} position={[0, EYE_HEIGHT + 0.35, 0]}>
        <NameTag name={name} />
      </group>
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
  const { texture, mirrorTexture, aspect } = useMemo(() => {
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

    // 鏡の反射はシーン全体を左右反転する。反射カメラ用には、あらかじめ
    // 左右反転したテクスチャを別レイヤーで描き、二重反転で読めるようにする。
    const mirrorTexture = texture.clone();
    mirrorTexture.wrapS = RepeatWrapping;
    mirrorTexture.repeat.x = -1;
    mirrorTexture.offset.x = 1;
    mirrorTexture.colorSpace = SRGBColorSpace;
    mirrorTexture.needsUpdate = true;

    return { texture, mirrorTexture, aspect: w / h };
  }, [name]);

  useEffect(() => () => {
    texture.dispose();
    mirrorTexture.dispose();
  }, [texture, mirrorTexture]);

  const normalRef = useRef<Sprite>(null);
  const mirrorRef = useRef<Sprite>(null);

  useLayoutEffect(() => {
    if (normalRef.current) {
      normalRef.current.layers.set(NAMEPLATE_LAYER);
      normalRef.current.userData.isNameplate = true;
    }
    if (mirrorRef.current) {
      mirrorRef.current.layers.set(NAMEPLATE_MIRROR_LAYER);
      mirrorRef.current.userData.isNameplate = true;
    }
  }, [texture, mirrorTexture]);

  return (
    <>
      <sprite ref={normalRef} scale={[TAG_HEIGHT * aspect, TAG_HEIGHT, 1]}>
        <spriteMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
      </sprite>
      <sprite ref={mirrorRef} scale={[TAG_HEIGHT * aspect, TAG_HEIGHT, 1]}>
        <spriteMaterial map={mirrorTexture} transparent depthWrite={false} toneMapped={false} />
      </sprite>
    </>
  );
}
