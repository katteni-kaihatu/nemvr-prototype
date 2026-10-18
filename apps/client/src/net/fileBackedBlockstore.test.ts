import { unixfs } from "@helia/unixfs";
import { MemoryBlockstore } from "blockstore-core";
import { exporter } from "ipfs-unixfs-exporter";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
import { describe, expect, it } from "vitest";
import { FileBackedBlockstore, ServingBlockstore, importFileBacked } from "./fileBackedBlockstore";

const MIB = 1024 * 1024;

/** 乱数で埋めたバイト列 (ブロックごとに違う)。 */
function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let o = 0; o < size; o += 65536) crypto.getRandomValues(bytes.subarray(o, Math.min(o + 65536, size)));
  return bytes;
}

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

/** Helia の既定の取り込み (`fs.addByteStream`) で、同じバイト列から作った CID。 */
async function heliaCid(bytes: Uint8Array): Promise<string> {
  const fs = unixfs({ blockstore: new MemoryBlockstore() });
  return (await fs.addBytes(bytes)).toString();
}

/** 配信用のブロックストアから、公式のエクスポーターで全バイトを読み戻す。 */
async function readBack(cid: CID, store: ServingBlockstore): Promise<Uint8Array> {
  const entry = await exporter(cid, store);
  if (entry.type !== "file" && entry.type !== "raw") throw new Error(`unexpected entry type ${entry.type}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of entry.content()) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const SIZES: [string, number][] = [
  ["empty", 0],
  ["1 byte", 1],
  ["just under one chunk", MIB - 1],
  ["exactly one chunk", MIB],
  ["one chunk + 1 byte", MIB + 1],
  ["3.5 chunks", 3.5 * MIB],
  ["16 chunks", 16 * MIB],
];

describe("importFileBacked", () => {
  for (const [label, size] of SIZES) {
    it(`gives the same CID as Helia's default import, and serves every byte back (${label})`, async () => {
      const bytes = randomBytes(size);
      const { cid, blockstore } = await importFileBacked(blobOf(bytes));
      expect(cid.toString()).toBe(await heliaCid(bytes));

      const serving = new ServingBlockstore();
      serving.serve(cid.toString(), blockstore);
      const back = await readBack(cid, serving);
      expect(back.length).toBe(size);
      expect(Buffer.compare(back, bytes)).toBe(0);
    }, 30_000);
  }

  it("handles files with repeated (identical) blocks, which the importer writes more than once", async () => {
    // 同じ 1MiB のブロックが何度も出てくるファイル。内容が同じブロックも、ファイルの中では位置を占める
    const block = randomBytes(MIB);
    const other = randomBytes(MIB);
    const bytes = new Uint8Array(6 * MIB);
    [block, block, other, block, other, other].forEach((b, i) => bytes.set(b, i * MIB));

    const { cid, blockstore } = await importFileBacked(blobOf(bytes));
    expect(cid.toString()).toBe(await heliaCid(bytes));
    const serving = new ServingBlockstore();
    serving.serve(cid.toString(), blockstore);
    expect(Buffer.compare(await readBack(cid, serving), bytes)).toBe(0);
  }, 30_000);

  it("handles a file of zeros (every block identical)", async () => {
    const bytes = new Uint8Array(5 * MIB);
    const { cid, blockstore } = await importFileBacked(blobOf(bytes));
    expect(cid.toString()).toBe(await heliaCid(bytes));
    const serving = new ServingBlockstore();
    serving.serve(cid.toString(), blockstore);
    expect(Buffer.compare(await readBack(cid, serving), bytes)).toBe(0);
  }, 30_000);

  it("does not copy the content: only the small DAG nodes are kept in memory", async () => {
    const { blockstore } = await importFileBacked(blobOf(randomBytes(8 * MIB)));
    // 8 個のブロックと、ルートのノード 1 個の索引だけ (中身は持たない)
    expect(blockstore.blockCount).toBe(9);
  });

  it("reports progress up to the full size", async () => {
    const size = 4 * MIB + 123;
    const calls: [number, number][] = [];
    await importFileBacked(blobOf(randomBytes(size)), { onProgress: (loaded, total) => calls.push([loaded, total]) });
    expect(calls.length).toBeGreaterThanOrEqual(1); // ストリームのチャンクの大きさ次第 (Node は一度に返す)
    expect(calls.at(-1)).toEqual([size, size]);
    expect(calls.map((c) => c[0])).toEqual([...calls.map((c) => c[0])].sort((a, b) => a - b));
  });
});

describe("integrity", () => {
  /** 後から中身を書き換えられる Blob もどき (ファイルが、アップロードの途中で変更された状況を作る)。 */
  class MutableBlob {
    constructor(public bytes: Uint8Array) {}
    get size() {
      return this.bytes.length;
    }
    stream() {
      return new Blob([this.bytes as BlobPart]).stream();
    }
    slice(start: number, end: number) {
      const part = this.bytes.slice(start, end);
      return { arrayBuffer: async () => part.buffer };
    }
  }

  it("refuses to serve a block whose bytes changed after it was indexed", async () => {
    const bytes = randomBytes(3 * MIB);
    const source = new MutableBlob(bytes);
    const { cid, blockstore } = await importFileBacked(source as unknown as Blob);
    const serving = new ServingBlockstore();
    serving.serve(cid.toString(), blockstore);
    expect(Buffer.compare(await readBack(cid, serving), bytes)).toBe(0); // 変更前は読める

    source.bytes = new Uint8Array(bytes); // 2 つ目のブロックの中身を書き換える
    source.bytes[MIB + 5] = (source.bytes[MIB + 5] ?? 0) ^ 0xff;
    await expect(readBack(cid, serving)).rejects.toThrow();
  }, 30_000);

  it("refuses unknown blocks", async () => {
    const store = new FileBackedBlockstore(blobOf(randomBytes(10)));
    const unknown = CID.createV1(0x55, await sha256.digest(new Uint8Array([1, 2, 3])));
    expect(await store.has(unknown)).toBe(false);
    await expect(store.get(unknown).next()).rejects.toThrow();
  });
});

describe("ServingBlockstore", () => {
  it("serves the blocks of active uploads, and stops when told to", async () => {
    const bytes = randomBytes(2 * MIB);
    const { cid, blockstore } = await importFileBacked(blobOf(bytes));
    const serving = new ServingBlockstore();
    expect(await serving.has(cid)).toBe(false);

    serving.serve(cid.toString(), blockstore);
    expect(serving.servingCount).toBe(1);
    expect(await serving.has(cid)).toBe(true);

    serving.stop(cid.toString());
    expect(serving.servingCount).toBe(0);
    expect(await serving.has(cid)).toBe(false);
    await expect(serving.get(cid).next()).rejects.toThrow();
  });

  it("serves several uploads at the same time", async () => {
    const a = randomBytes(2 * MIB);
    const b = randomBytes(3 * MIB);
    const ia = await importFileBacked(blobOf(a));
    const ib = await importFileBacked(blobOf(b));
    const serving = new ServingBlockstore();
    serving.serve(ia.cid.toString(), ia.blockstore);
    serving.serve(ib.cid.toString(), ib.blockstore);
    expect(Buffer.compare(await readBack(ia.cid, serving), a)).toBe(0);
    expect(Buffer.compare(await readBack(ib.cid, serving), b)).toBe(0);
  }, 30_000);

  it("does not keep blocks it is given (downloads are streamed through, not stored)", async () => {
    const serving = new ServingBlockstore();
    const cid = CID.createV1(0x55, await sha256.digest(new Uint8Array([9, 9, 9])));
    expect(await serving.put(cid)).toBe(cid);
    expect(await serving.has(cid)).toBe(false);
    await expect(serving.get(cid).next()).rejects.toThrow();
    await expect(serving.delete()).resolves.toBeUndefined();
  });
});
