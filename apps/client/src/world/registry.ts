import type { Mesh } from "three";

/** 描画中のオブジェクト ID → メッシュ。画面中央のレイとの当たり判定に使う。 */
export const objectMeshes = new Map<string, Mesh>();
