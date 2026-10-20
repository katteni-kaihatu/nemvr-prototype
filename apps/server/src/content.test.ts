import { describe, expect, it } from "vitest";
import { MAX_AVATAR_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from "@proto/protocol";
import { ContentStore, type ContentBackend } from "./content.js";
import { ContentRejected, type Fetched, type FetchLimits } from "./ipfs.js";

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const TEXT_HEAD = new TextEncoder().encode("hello world");

/** IPFS ノードの代わり。何が起きたかを events に記録する。 */
class FakeBackend implements ContentBackend {
  contents = new Map<string, Fetched>();
  pinned = new Set<string>();
  events: string[] = [];
  fetchDelayMs = 0;
  failPin = false;

  put(cid: string, size: number, head: Uint8Array = TEXT_HEAD): void {
    this.contents.set(cid, { size, head });
  }

  failAfterDeclared = false;

  async fetchVerified(cid: string, limits: FetchLimits): Promise<Fetched> {
    const content = this.contents.get(cid);
    if (limits.headOnly) {
      // 先頭だけ取得する。宣言されたサイズと先頭を返し、中身の全部は取得しない
      this.events.push(`head:${cid}`);
      if (!content) throw new ContentRejected("IPFS から取得できませんでした");
      if (content.size > limits.maxBytes) throw new ContentRejected(limits.tooLargeMessage);
      return content;
    }
    this.events.push(`fetch:start:${cid}`);
    if (!content) throw new ContentRejected("IPFS から取得できませんでした");
    if (content.size > limits.maxBytes) throw new ContentRejected(limits.tooLargeMessage);
    // 本物と同じく、ルートのブロックが読めた時点 (中身の取得の前) に、宣言されたサイズを知らせる
    limits.onDeclaredSize?.(content.size);
    this.events.push(`declared:${cid}`);
    if (this.fetchDelayMs) await new Promise((r) => setTimeout(r, this.fetchDelayMs));
    if (this.failAfterDeclared) throw new ContentRejected("IPFS から取得できませんでした");
    limits.onProgress?.(Math.floor(content.size / 2), content.size);
    limits.onProgress?.(content.size, content.size);
    this.events.push(`fetch:end:${cid}`);
    return content;
  }
  async pin(cid: string): Promise<void> {
    if (this.failPin) throw new Error("pin failed");
    this.pinned.add(cid);
    this.events.push(`pin:${cid}`);
  }
  async unpin(cid: string): Promise<void> {
    this.pinned.delete(cid);
    this.events.push(`unpin:${cid}`);
  }
  async gc(): Promise<void> {
    this.events.push("gc:start");
    await new Promise((r) => setTimeout(r, 5));
    this.events.push("gc:end");
  }
  async has(cid: string): Promise<boolean> {
    return this.contents.has(cid);
  }
  count(prefix: string): number {
    return this.events.filter((e) => e.startsWith(prefix)).length;
  }
}

const make = (maxTotalBytes = 1000) => {
  const backend = new FakeBackend();
  const store = new ContentStore(backend, { maxTotalBytes, gcDelayMs: 5 });
  return { backend, store };
};

describe("add", () => {
  it("fetches, pins and accounts for a file", async () => {
    const { backend, store } = make();
    backend.put("a", 300);
    expect(await store.add("a", "file")).toEqual({ size: 300, head: TEXT_HEAD });
    expect(backend.pinned.has("a")).toBe(true);
    expect(store.totalBytes).toBe(300);
    expect(store.count).toBe(1);
  });

  it("accepts any content as a file, but only real images as images", async () => {
    const { backend, store } = make();
    backend.put("text", 10, TEXT_HEAD);
    backend.put("png", 10, PNG_HEAD);
    await expect(store.add("text", "image")).rejects.toThrow(/対応していない画像形式/);
    expect(backend.pinned.has("text")).toBe(false);
    await expect(store.add("png", "image")).resolves.toBeDefined();
    await expect(store.add("text", "file")).resolves.toBeDefined();
  });

  it("applies the per-kind size limits (images 5MB, files 2GiB)", async () => {
    const { backend, store } = make(4 * MAX_FILE_BYTES); // 合計の上限は、種類ごとの上限に影響しないよう大きくしておく
    backend.put("big-image", MAX_IMAGE_BYTES + 1, PNG_HEAD);
    backend.put("big-file", MAX_FILE_BYTES + 1);
    backend.put("ok-file", MAX_FILE_BYTES);
    await expect(store.add("big-image", "image")).rejects.toThrow(/画像が大きすぎます/);
    await expect(store.add("big-file", "file")).rejects.toThrow(/ファイルが大きすぎます/);
    // 画像としては大きすぎる内容も、ファイルとしてなら置ける
    backend.put("img-as-file", MAX_IMAGE_BYTES + 1, PNG_HEAD);
    await expect(store.add("img-as-file", "file")).resolves.toBeDefined();
    await expect(store.add("ok-file", "file")).resolves.toBeDefined();
  });

  it("applies the avatar size limit (64MB) without the image format check", async () => {
    const { backend, store } = make(4 * MAX_AVATAR_BYTES); // 合計の上限は、種類ごとの上限に影響しないよう大きくしておく
    backend.put("big-avatar", MAX_AVATAR_BYTES + 1);
    backend.put("ok-avatar", MAX_AVATAR_BYTES, TEXT_HEAD);
    await expect(store.add("big-avatar", "avatar")).rejects.toThrow(/アバターが大きすぎます/);
    await expect(store.add("ok-avatar", "avatar")).resolves.toBeDefined();
    expect(backend.pinned.has("big-avatar")).toBe(false);
  });

  it("re-checks the image policy when the content is already held as a file", async () => {
    const { backend, store } = make();
    backend.put("x", 10, TEXT_HEAD);
    await store.add("x", "file");
    await expect(store.add("x", "image")).rejects.toThrow(/対応していない画像形式/);
    expect(store.count).toBe(1);
  });

  it("rejects when the total capacity would be exceeded, and recovers after a release", async () => {
    const { backend, store } = make(500);
    backend.put("a", 300);
    backend.put("b", 300);
    await store.add("a", "file");
    await expect(store.add("b", "file")).rejects.toThrow(/保存容量の上限/);
    expect(backend.pinned.has("b")).toBe(false);
    expect(store.totalBytes).toBe(300);

    store.release("a");
    await expect(store.add("b", "file")).resolves.toBeDefined();
    expect(store.totalBytes).toBe(300);
  });

  it("propagates fetch failures without registering anything", async () => {
    const { store } = make();
    await expect(store.add("missing", "file")).rejects.toThrow(/取得できませんでした/);
    expect(store.count).toBe(0);
    expect(store.totalBytes).toBe(0);
  });

  it("rolls back when pinning fails", async () => {
    const { backend, store } = make();
    backend.put("a", 100);
    backend.failPin = true;
    await expect(store.add("a", "file")).rejects.toThrow(/pin failed/);
    expect(store.count).toBe(0);
    expect(store.totalBytes).toBe(0);
  });
});

describe("probe (head only: nothing is stored)", () => {
  it("returns the declared size and head without fetching the content, pinning it or using capacity", async () => {
    const { backend, store } = make(100);
    backend.put("big", 1_000_000_000, PNG_HEAD); // 容量 (100) より大きい宣言サイズ
    const info = await store.probe("big", "file");
    expect(info).toEqual({ size: 1_000_000_000, head: PNG_HEAD });
    expect(backend.pinned.size).toBe(0);
    expect(store.totalBytes).toBe(0);
    expect(store.count).toBe(0);
    expect(store.known("big")).toBeUndefined();
    expect(backend.events).toEqual(["head:big"]); // fetch:start / fetch:end / pin は無い
  });

  it("answers from what is already held, without going to the network", async () => {
    const { backend, store } = make();
    backend.put("a", 300);
    await store.add("a", "file");
    backend.events.length = 0;
    expect(await store.probe("a", "file")).toEqual({ size: 300, head: TEXT_HEAD });
    expect(store.known("a")).toEqual({ size: 300, head: TEXT_HEAD });
    expect(backend.events).toEqual([]);
  });

  it("applies the same policy as a real add (size limits, image format)", async () => {
    const { backend, store } = make();
    backend.put("huge", MAX_FILE_BYTES + 1);
    backend.put("text", 10, TEXT_HEAD);
    await expect(store.probe("huge", "file")).rejects.toThrow(/ファイルが大きすぎます/);
    await expect(store.probe("text", "image")).rejects.toThrow(/対応していない画像形式/);
    await expect(store.probe("text", "file")).resolves.toBeDefined();
  });

  it("propagates failures (the owner cannot be reached) and does not register anything", async () => {
    const { store } = make();
    await expect(store.probe("missing", "file")).rejects.toThrow(/取得できませんでした/);
    expect(store.count).toBe(0);
  });

  it("schedules a gc for the blocks fetched while probing", async () => {
    const { backend, store } = make();
    backend.put("a", 10);
    await store.probe("a", "file");
    await store.settle();
    expect(backend.count("gc:end")).toBe(1);
  });
});

describe("progress", () => {
  it("forwards the fetch progress (loaded bytes and declared size) to the caller", async () => {
    const { backend, store } = make(1000);
    backend.put("a", 400);
    const calls: [number, number][] = [];
    await store.add("a", "file", { onProgress: (loaded, declared) => calls.push([loaded, declared]) });
    expect(calls).toEqual([[200, 400], [400, 400]]);
  });

  it("does not call progress for content that is already held", async () => {
    const { backend, store } = make(1000);
    backend.put("a", 400);
    await store.add("a", "file");
    let called = false;
    await store.add("a", "file", { onProgress: () => (called = true) });
    expect(called).toBe(false);
  });
});

describe("references", () => {
  it("holds identical content once, and frees it only after the last reference", async () => {
    const { backend, store } = make();
    backend.put("a", 200);
    await store.add("a", "file");
    await store.add("a", "file"); // 同じファイルの再投入
    expect(backend.count("fetch:start")).toBe(1); // 取得し直さない
    expect(store.totalBytes).toBe(200); // 容量は 1 回分
    store.retain("a"); // 複製

    store.release("a");
    store.release("a");
    await store.settle();
    expect(backend.pinned.has("a")).toBe(true);
    expect(store.totalBytes).toBe(200);

    store.release("a"); // 最後の参照
    await store.settle();
    expect(backend.pinned.has("a")).toBe(false);
    expect(store.totalBytes).toBe(0);
    expect(store.count).toBe(0);
    expect(backend.count("gc:end")).toBe(1);
  });

  it("ignores release / retain for unknown content", async () => {
    const { backend, store } = make();
    store.release("nope");
    store.retain("nope");
    await store.settle();
    expect(backend.events).toEqual([]);
  });

  it("registers identical content added concurrently only once", async () => {
    const { backend, store } = make();
    backend.put("a", 200);
    backend.fetchDelayMs = 20;
    const [r1, r2] = await Promise.all([store.add("a", "file"), store.add("a", "file")]);
    expect(r1.size).toBe(200);
    expect(r2.size).toBe(200);
    expect(store.totalBytes).toBe(200); // 二重に数えない
    expect(backend.count("pin:")).toBe(1);

    store.release("a");
    await store.settle();
    expect(backend.pinned.has("a")).toBe(true); // 参照は 2 つあった
    store.release("a");
    await store.settle();
    expect(backend.pinned.has("a")).toBe(false);
  });

  it("does not let concurrent adds exceed the capacity together", async () => {
    const { backend, store } = make(100);
    backend.put("a", 60);
    backend.put("b", 60);
    backend.fetchDelayMs = 10;
    const results = await Promise.allSettled([store.add("a", "file"), store.add("b", "file")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(store.totalBytes).toBe(60);
  });

  it("reserves capacity from the declared size, so an over-capacity upload is rejected before it is downloaded", async () => {
    const { backend, store } = make(100);
    backend.put("a", 60);
    backend.put("b", 60);
    backend.fetchDelayMs = 20;
    const [ra, rb] = await Promise.allSettled([store.add("a", "file"), store.add("b", "file")]);
    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("rejected"); // 後から来たほうは、予約で弾かれる
    expect((rb as PromiseRejectedResult).reason.message).toMatch(/保存容量の上限/);
    // 弾かれたほうは、中身を取得していない
    expect(backend.events).not.toContain("fetch:end:b");
  });

  it("releases the reservation when a fetch fails, so later uploads can use the space", async () => {
    const { backend, store } = make(100);
    backend.put("a", 80);
    backend.put("b", 80);
    backend.failAfterDeclared = true;
    await expect(store.add("a", "file")).rejects.toThrow(/取得できませんでした/);
    backend.failAfterDeclared = false;
    await expect(store.add("b", "file")).resolves.toBeDefined(); // 予約が残っていたら、ここで容量不足になる
    expect(store.totalBytes).toBe(80);
  });

  it("does not leak a reservation after a successful add", async () => {
    const { backend, store } = make(100);
    backend.put("a", 60);
    await store.add("a", "file");
    store.release("a");
    await store.settle();
    backend.put("b", 90);
    await expect(store.add("b", "file")).resolves.toBeDefined(); // 60 の予約が残っていたら入らない
  });
});

describe("garbage collection", () => {
  it("is deferred while a fetch is in flight, so the fetched blocks are not collected", async () => {
    const { backend, store } = make();
    backend.put("a", 100);
    backend.put("b", 100);
    await store.add("a", "file");

    backend.fetchDelayMs = 60;
    const adding = store.add("b", "file"); // 取得中
    store.release("a"); // gc が予約される (5ms 後)
    await adding;
    await store.settle();

    const gcStart = backend.events.indexOf("gc:start");
    const fetchEnd = backend.events.indexOf("fetch:end:b");
    const pinB = backend.events.indexOf("pin:b");
    expect(gcStart).toBeGreaterThan(fetchEnd);
    expect(gcStart).toBeGreaterThan(pinB);
  });

  it("makes an add wait for a gc that is already running", async () => {
    const { backend, store } = make();
    backend.put("a", 100);
    backend.put("b", 100);
    await store.add("a", "file");
    store.release("a");
    await new Promise((r) => setTimeout(r, 8)); // gc が始まるまで待つ
    expect(backend.events).toContain("gc:start");

    await store.add("b", "file");
    const gcEnd = backend.events.indexOf("gc:end");
    const fetchStartB = backend.events.indexOf("fetch:start:b");
    expect(fetchStartB).toBeGreaterThan(gcEnd); // gc が終わってから取得を始める
  });

  it("cleans up partially fetched blocks after a rejected add", async () => {
    const { backend, store } = make();
    backend.put("big", MAX_FILE_BYTES + 1);
    await expect(store.add("big", "file")).rejects.toThrow();
    await store.settle();
    expect(backend.count("gc:end")).toBe(1);
  });

  it("batches several releases into one gc", async () => {
    const { backend, store } = make();
    for (const cid of ["a", "b", "c"]) {
      backend.put(cid, 10);
      await store.add(cid, "file");
    }
    for (const cid of ["a", "b", "c"]) store.release(cid);
    await store.settle();
    expect(backend.count("unpin:")).toBe(3);
    expect(backend.count("gc:end")).toBe(1);
  });
});

describe("content ledger", () => {
  it("restores content that is still in the blockstore, pins it, and drops missing content", async () => {
    const { backend, store } = make();
    backend.put("present", 120);
    await store.restore([
      { cid: "present", size: 120, head: [...TEXT_HEAD], refs: 2 },
      { cid: "missing", size: 30, head: [], refs: 1 },
    ]);

    expect(store.known("present")).toEqual({ size: 120, head: TEXT_HEAD });
    expect(store.known("missing")).toBeUndefined();
    expect(backend.pinned.has("present")).toBe(true);
    expect(backend.pinned.has("missing")).toBe(false);
    expect(store.totalBytes).toBe(120);
    expect(store.count).toBe(1);
  });

  it("roundtrips through snapshot and restore", async () => {
    const { backend, store } = make();
    backend.put("a", 400);
    await store.add("a", "file");
    store.retain("a");
    const snapshot = store.snapshot();
    expect(snapshot).toEqual([{ cid: "a", size: 400, head: [...TEXT_HEAD], refs: 2 }]);

    const restored = new ContentStore(backend, { maxTotalBytes: 1000 });
    await restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.known("a")).toEqual({ size: 400, head: TEXT_HEAD });
  });

  it("ignores invalid entries without throwing, and restores the valid ones", async () => {
    const { backend, store } = make();
    backend.put("ok", 10);
    await expect(
      store.restore([
        null,
        42,
        {},
        { cid: "", size: 10, head: [], refs: 1 },
        { cid: "neg", size: -1, head: [], refs: 1 },
        { cid: "head", size: 10, head: [300], refs: 1 },
        { cid: "refs", size: 10, head: [], refs: 0 },
        { cid: "ok", size: 10, head: [...TEXT_HEAD], refs: 1 },
      ]),
    ).resolves.toBeUndefined();
    expect(store.count).toBe(1);
    expect(store.known("ok")).toBeDefined();
  });

  it("does not register an entry when pinning fails, and continues with the rest", async () => {
    const { backend, store } = make();
    backend.put("bad", 10);
    backend.put("good", 20);
    backend.failPin = true;
    await store.restore([{ cid: "bad", size: 10, head: [], refs: 1 }]);
    expect(store.known("bad")).toBeUndefined();
    backend.failPin = false;
    await store.restore([{ cid: "good", size: 20, head: [], refs: 1 }]);
    expect(store.known("good")).toBeDefined();
  });

  it("does not restore entries that would exceed the total capacity", async () => {
    const { backend, store } = make(500);
    backend.put("first", 300);
    backend.put("too-big", 300);
    backend.put("fits", 200);
    await store.restore([
      { cid: "first", size: 300, head: [...TEXT_HEAD], refs: 1 },
      { cid: "too-big", size: 300, head: [...TEXT_HEAD], refs: 1 },
      { cid: "fits", size: 200, head: [...TEXT_HEAD], refs: 1 },
    ]);
    expect(store.known("first")).toBeDefined();
    expect(store.known("too-big")).toBeUndefined();
    expect(store.known("fits")).toBeDefined();
    expect(store.totalBytes).toBe(500);
    expect(backend.pinned.has("too-big")).toBe(false);
  });

  it("notifies onChange after add, retain and release", async () => {
    const backend = new FakeBackend();
    let changes = 0;
    const store = new ContentStore(backend, { maxTotalBytes: 1000, gcDelayMs: 5, onChange: () => changes++ });
    backend.put("a", 10);
    await store.add("a", "file");
    expect(changes).toBe(1);
    store.retain("a");
    expect(changes).toBe(2);
    store.release("a");
    expect(changes).toBe(3);
    store.release("a");
    expect(changes).toBe(4);
    await store.settle();
  });
});
