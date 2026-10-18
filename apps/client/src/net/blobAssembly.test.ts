import { describe, expect, it } from "vitest";
import { assembleBlob } from "./blobAssembly";

async function* from(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe("assembleBlob", () => {
  it("joins chunks in order, whatever the batch size", async () => {
    const chunks = [3, 1, 7, 100, 2, 50].map((n, i) => new Uint8Array(n).fill(i + 1));
    for (const batchBytes of [1, 4, 50, 1000]) {
      const blob = await assembleBlob(from(chunks), { maxBytes: 10_000, batchBytes });
      expect(Buffer.compare(await bytesOf(blob), concat(chunks))).toBe(0);
    }
  });

  it("returns an empty Blob for an empty source", async () => {
    const blob = await assembleBlob(from([]), { maxBytes: 10, batchBytes: 4 });
    expect(blob.size).toBe(0);
  });

  it("copies each chunk when it arrives: a producer that reuses its buffer must not corrupt the result", async () => {
    // 取得元が、1 つのバッファを再利用して、チャンクを (同じ領域の見え方として) 次々に渡す状況
    const shared = new Uint8Array(1000);
    const expected: Uint8Array[] = [];
    async function* reusing(): AsyncGenerator<Uint8Array> {
      for (let i = 1; i <= 40; i++) {
        shared.fill(i);
        expected.push(shared.slice()); // その時点の、正しい中身
        yield shared.subarray(0, 1000); // 同じバッファの見え方を渡す
        // 渡したあとは、取得元が次の内容で上書きする (ループの次の周)
      }
    }
    // バッチを大きくして、Blob にするのを遅らせる (= 持っている間に、元のバッファが書き換わる)
    const blob = await assembleBlob(reusing(), { maxBytes: 1_000_000, batchBytes: 100_000 });
    expect(Buffer.compare(await bytesOf(blob), concat(expected))).toBe(0);
  });

  it("(documents the hazard) without copying, a reused buffer WOULD corrupt the batch", async () => {
    // コピーせずに持っておく素朴な組み立てだと、壊れることを示す。上のテストが、本当に問題を捕まえられることの裏付け
    const shared = new Uint8Array(1000);
    const expected: Uint8Array[] = [];
    const naive: Uint8Array[] = [];
    for (let i = 1; i <= 5; i++) {
      shared.fill(i);
      expected.push(shared.slice());
      naive.push(shared.subarray(0, 1000)); // コピーしない
    }
    const naiveBlob = new Blob(naive as BlobPart[]);
    expect(Buffer.compare(await bytesOf(naiveBlob), concat(expected))).not.toBe(0);
  });

  it("copies only the viewed range of a larger underlying buffer", async () => {
    const backing = new Uint8Array(100);
    backing.set([1, 2, 3, 4, 5], 40);
    const view = backing.subarray(40, 45);
    const blob = await assembleBlob(from([view]), { maxBytes: 100, batchBytes: 1000 });
    expect([...(await bytesOf(blob))]).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops with an error when the size limit is exceeded (but allows exactly the limit)", async () => {
    const chunks = [new Uint8Array(60), new Uint8Array(40)];
    await expect(assembleBlob(from(chunks), { maxBytes: 100, batchBytes: 1000 })).resolves.toBeInstanceOf(Blob);
    await expect(assembleBlob(from(chunks), { maxBytes: 99, batchBytes: 1000 })).rejects.toThrow(/上限/);
  });

  it("reports cumulative progress and calls onChunk for every chunk", async () => {
    const progress: number[] = [];
    let chunks = 0;
    await assembleBlob(from([new Uint8Array(10), new Uint8Array(5), new Uint8Array(20)]), {
      maxBytes: 1000,
      batchBytes: 12,
      onProgress: (n) => progress.push(n),
      onChunk: () => chunks++,
    });
    expect(progress).toEqual([10, 15, 35]);
    expect(chunks).toBe(3);
  });
});
