import type { WorldObject } from "@proto/protocol";

/**
 * 自分のブラウザが、このファイル (CID) を、まだ配り続ける必要があるか。
 *
 * 大きなファイルは、ダウンロードされるまでサーバーが取得しない (遅延転送) ので、置いた人のブラウザが、
 * その間は元のファイルから配る。必要なのは「自分が置いて、サーバーがまだ保持していない」ファイルが、
 * 1 つでも残っている間だけ。サーバーが保持した (stored)、または、すべて削除されたら、配るのをやめてよい。
 */
export function needsLocalFile(objects: Record<string, WorldObject>, cid: string, selfId: string | undefined): boolean {
  if (!selfId) return false;
  return Object.values(objects).some((o) => o.kind === "file" && o.cid === cid && !o.stored && o.owner === selfId);
}
