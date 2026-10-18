export interface AssembleOptions {
  /** この大きさを超えたら、例外を投げて中止する (バイト) */
  maxBytes: number;
  /** この大きさごとに Blob にまとめる (全チャンクを配列に溜めて、メモリを使い切らないように) */
  batchBytes: number;
  /** チャンクを受け取るたびに呼ばれる (アイドルタイムアウトの時計を戻すのに使う) */
  onChunk?: () => void;
  /** 受け取った合計のバイト数 */
  onProgress?: (loadedBytes: number) => void;
}

/**
 * チャンクの列を、1 つの Blob にまとめる。
 *
 * 一定の大きさごとに Blob にして、全チャンクを配列に溜めない (ブラウザは大きな Blob を、メモリの外に置ける)。
 *
 * **チャンクは、受け取った時点で必ずコピーする。** 受け取ったチャンクは、取得元のバッファの一部を指す「見え方」
 * (`subarray`) のことがあり、取得元は、チャンクを渡したあとに、そのバッファを再利用して書き換えてよい。
 * Blob にするのは、バッチが溜まってから (最大 batchBytes 分あとから) なので、コピーせずに持っておくと、
 * その間に中身が書き換わって、保存されるファイルが壊れる恐れがある。
 */
export async function assembleBlob(source: AsyncIterable<Uint8Array>, options: AssembleOptions): Promise<Blob> {
  const { maxBytes, batchBytes, onChunk, onProgress } = options;
  const parts: Blob[] = [];
  let batch: Uint8Array[] = [];
  let batchSize = 0;
  let size = 0;

  for await (const chunk of source) {
    onChunk?.();
    size += chunk.length;
    if (size > maxBytes) throw new Error("サイズの上限を超えています");
    batch.push(chunk.slice()); // 今この場でコピーする (`slice` は、範囲の分だけを新しいバッファに写す)
    batchSize += chunk.length;
    if (batchSize >= batchBytes) {
      parts.push(new Blob(batch as BlobPart[]));
      batch = [];
      batchSize = 0;
    }
    onProgress?.(size);
  }
  if (batch.length > 0) parts.push(new Blob(batch as BlobPart[]));
  return new Blob(parts);
}
