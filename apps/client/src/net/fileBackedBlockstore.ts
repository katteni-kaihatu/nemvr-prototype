import { BaseBlockstore } from "blockstore-core";
import { importFile } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { NotFoundError } from "interface-store";
import { sha256 } from "multiformats/hashes/sha2";
import type { CID } from "multiformats/cid";
import type { Pair } from "interface-blockstore";

/**
 * アップロードするファイルを、IPFS のブロックとして配るための仕組み。
 *
 * 大きなファイル (最大 2 GiB) をブラウザ内の IPFS ノードに「保存」すると、IndexedDB への書き込みと読み出しが
 * 非常に遅く (Firefox で 1MiB あたり 0.2〜0.3 秒)、サーバーが取りに来ても応答できず止まってしまった。
 * メモリに置けば速いが、ファイルのサイズ分のメモリを使う。
 *
 * ブラウザの `File` は、そもそもディスク上のファイルを読める。なのでブロックの中身は保存せず、
 * 「このブロックは、ファイルの何バイト目から何バイト分か」という索引だけを持ち、要求されたときに元のファイルから読む。
 * コピーを作らないので、メモリもディスクも使わず、取り込みはハッシュを計算する速さで済む。
 */

const RAW_CODEC = 0x55;
const CHUNK_SIZE = 1_048_576;

/** 1 つのアップロード (1 つのファイル) の分のブロック。 */
export class FileBackedBlockstore extends BaseBlockstore {
  /** 生のブロック (ファイルの中身そのもの) → ファイル内の範囲 */
  private readonly leaves = new Map<string, { offset: number; length: number }>();
  /** 中間のノード (DAG の枝)。ファイルの内容ではなく小さいので、メモリに持つ。 */
  private readonly nodes = new Map<string, Uint8Array>();
  private nextOffset = 0;

  constructor(private readonly file: Blob) {
    super();
  }

  /**
   * インポーターが書き込むブロックを受け取る。生のブロックは、中身を捨てて範囲だけ覚える。
   *
   * 範囲は「生のブロックが書かれた順に、ファイルの先頭から並んでいる」ことから決める。
   * そのため、インポーターは blockWriteConcurrency: 1 (順番に書く) で動かすこと。
   * 内容が同じブロックも、ファイルの中では位置を占めるので、数え直す (最初の位置だけを索引に残す)。
   */
  async put(key: CID, val: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<CID> {
    const bytes = val instanceof Uint8Array ? val : concat(await collect(val));
    if (key.code === RAW_CODEC) {
      const id = key.toString();
      if (!this.leaves.has(id)) this.leaves.set(id, { offset: this.nextOffset, length: bytes.length });
      this.nextOffset += bytes.length;
    } else {
      this.nodes.set(key.toString(), bytes);
    }
    return key;
  }

  async has(key: CID): Promise<boolean> {
    const id = key.toString();
    return this.nodes.has(id) || this.leaves.has(id);
  }

  async *get(key: CID): AsyncGenerator<Uint8Array> {
    const id = key.toString();
    const node = this.nodes.get(id);
    if (node) {
      yield node;
      return;
    }
    const leaf = this.leaves.get(id);
    if (!leaf) throw new NotFoundError();

    const bytes = new Uint8Array(await this.file.slice(leaf.offset, leaf.offset + leaf.length).arrayBuffer());
    // 配るブロックは CID と一致していなければならない。ファイルがアップロードの途中で書き換えられた場合などに、
    // 壊れたブロックを配らないよう、読んだ内容のハッシュを確かめる (相手も検証するが、ここで止めて原因を分かりやすくする)
    const digest = await sha256.digest(bytes);
    if (!equals(digest.digest, key.multihash.digest)) {
      throw new NotFoundError("the file changed while it was being uploaded");
    }
    yield bytes;
  }

  async delete(): Promise<void> {
    // 配る期間が終われば、まとめて捨てる。個別には消さない
  }

  async *getAll(): AsyncGenerator<Pair> {
    // 列挙は使わない (ガーベジコレクションもしない)
  }

  /** この索引のブロック数 (診断・テスト用)。 */
  get blockCount(): number {
    return this.leaves.size + this.nodes.size;
  }
}

/**
 * ブラウザ内の IPFS ノードのブロックストア全体。
 *
 * - 配信中のアップロード (FileBackedBlockstore) のブロックを返す
 * - 取得したブロック (他の人のファイル・画像・ダウンロード) は保存しない。
 *   Helia は取得したブロックを保存先に書くが、そのまま呼び出し元にも返し、読み直さないので、捨てても動く。
 *   保存しないので、ダウンロードが大きくてもメモリやディスクを使わない (毎回ネットワークから取得する)
 */
export class ServingBlockstore extends BaseBlockstore {
  private readonly uploads = new Map<string, FileBackedBlockstore>();

  /** このファイル (ルートの CID) のブロックを、取り下げるまで配る。 */
  serve(rootCid: string, store: FileBackedBlockstore): void {
    this.uploads.set(rootCid, store);
  }

  /** 配るのをやめて、索引を捨てる。 */
  stop(rootCid: string): void {
    this.uploads.delete(rootCid);
  }

  get servingCount(): number {
    return this.uploads.size;
  }

  async put(key: CID): Promise<CID> {
    return key; // 取得したブロックは保存しない
  }

  async has(key: CID): Promise<boolean> {
    for (const store of this.uploads.values()) if (await store.has(key)) return true;
    return false;
  }

  async *get(key: CID): AsyncGenerator<Uint8Array> {
    for (const store of this.uploads.values()) {
      if (await store.has(key)) {
        yield* store.get(key);
        return;
      }
    }
    throw new NotFoundError();
  }

  async delete(): Promise<void> {
    // 何も保存していないので、消すものも無い
  }

  async *getAll(): AsyncGenerator<Pair> {
    // 列挙は使わない
  }
}

export interface ImportProgress {
  /** 読み込み済みのバイト数と、全体のバイト数 */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

/**
 * ファイルを UnixFS (IPFS) の DAG に取り込んで、ルートの CID と、ブロックを配るための索引を返す。
 * Helia の既定 (CIDv1、1MiB の固定チャンク、均衡レイアウト、生のブロック) と同じ設定なので、
 * 同じファイルは `fs.addByteStream` と同じ CID になる。
 */
export async function importFileBacked(
  file: Blob,
  { onProgress }: ImportProgress = {},
): Promise<{ cid: CID; blockstore: FileBackedBlockstore }> {
  const blockstore = new FileBackedBlockstore(file);

  async function* content(): AsyncGenerator<Uint8Array> {
    const reader = file.stream().getReader();
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        loaded += value.length;
        yield value;
        onProgress?.(loaded, file.size);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const { cid } = await importFile({ content: content() }, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    layout: balanced({ maxChildrenPerNode: 1024 }),
    chunker: fixedSize({ chunkSize: CHUNK_SIZE }),
    // 範囲の索引は、ブロックが先頭から順に書かれることを前提にしている。並行して書くと、順序が入れ替わる
    blockWriteConcurrency: 1,
  });
  return { cid, blockstore };
}

async function collect(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for await (const part of source) parts.push(part);
  return parts;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
