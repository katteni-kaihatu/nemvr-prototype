import type { WorldObject } from "@proto/protocol";

/**
 * 自分のブラウザが、このファイル (CID) を、まだ配り続ける必要があるか。
 *
 * 大きなファイルは、置いたあと、サーバーが取り終えるまで時間がかかるので、置いた人のブラウザが、
 * その間は元のファイルから配る。必要なのは「自分が置いて、サーバーがまだ保持していない」ファイルが、
 * 1 つでも残っている間だけ。サーバーが保持した (stored)、または、すべて削除されたら、配るのをやめてよい。
 * ただし映像は、他のブラウザに P2P で配れるように、タブが開いている間 (オブジェクトが残っている間) は配り続ける。
 */
export function needsLocalFile(
  objects: Record<string, WorldObject>,
  cid: string,
  selfId: string | undefined,
  /** このブラウザが、いまその CID を配っているか (自分が置いたもの) */
  serving = false,
): boolean {
  if (!selfId) return false;
  return Object.values(objects).some(
    (o) =>
      o.kind === "file" &&
      o.cid === cid &&
      // サーバーが取り終えるまでは、置いた人が配る
      ((!o.stored && o.owner === selfId) ||
        // 映像は、サーバーが保持したあとも、他のブラウザへ P2P で配れるように、このタブが開いている間は配り続ける
        (serving && o.category === "video")),
  );
}
