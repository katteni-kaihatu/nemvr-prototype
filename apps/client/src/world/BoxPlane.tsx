import type { BoxObject } from "@proto/protocol";
import { ObjectFrame } from "./ObjectFrame";

/** デモ空間のボックス。つかんで動かせる (高さ・水平方向・垂直方向の向きも変えられる)。position は底面の中央。 */
export function BoxPlane({ object }: { object: BoxObject }) {
  return (
    <ObjectFrame object={object} width={object.size} height={object.size} depth={object.size}>
      <meshStandardMaterial color={object.color} />
    </ObjectFrame>
  );
}
