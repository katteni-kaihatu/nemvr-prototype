import { describe, expect, it, vi } from "vitest";
import { RefCountedCache } from "./refCountedCache";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("RefCountedCache", () => {
  it("同じキーを同時に取得しても、読み込みは 1 回 (値を共有する)", async () => {
    const load = vi.fn(async () => "vrm");
    const cache = new RefCountedCache(load);
    const [a, b] = await Promise.all([cache.acquire("cid"), cache.acquire("cid")]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe("vrm");
    expect(b).toBe("vrm");
    expect(cache.keys()).toEqual(["cid"]);
  });

  it("1 人が見終わっても、まだ見ている人がいれば保持し、最後の 1 人が見終わったら捨てる", async () => {
    const load = vi.fn(async () => "vrm");
    const cache = new RefCountedCache(load);
    await cache.acquire("cid");
    await cache.acquire("cid");
    cache.release("cid");
    expect(cache.keys()).toEqual(["cid"]);
    cache.release("cid");
    expect(cache.keys()).toEqual([]);
    // もう一度取得すると、読み込み直す
    await cache.acquire("cid");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("取得中に全員が退出したら、読み込みを取り消す", async () => {
    const pending = deferred<string>();
    const signals: AbortSignal[] = [];
    const cache = new RefCountedCache((_key, signal) => {
      signals.push(signal);
      return pending.promise;
    });
    const value = cache.acquire("cid");
    cache.release("cid");
    expect(signals[0]!.aborted).toBe(true);
    expect(cache.keys()).toEqual([]);
    // 取り消したあとに完了しても保持しない
    pending.resolve("vrm");
    await expect(value).resolves.toBe("vrm");
    expect(cache.keys()).toEqual([]);
  });

  it("失敗した読み込みは保持しない (次に取得したらやり直す)", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce("vrm");
    const cache = new RefCountedCache(load);
    await expect(cache.acquire("cid")).rejects.toThrow("failed");
    cache.release("cid");
    expect(cache.keys()).toEqual([]);
    await expect(cache.acquire("cid")).resolves.toBe("vrm");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("別のキーは独立して数える", async () => {
    const load = vi.fn(async (key: string) => key.toUpperCase());
    const cache = new RefCountedCache(load);
    await cache.acquire("a");
    await cache.acquire("b");
    cache.release("a");
    expect(cache.keys()).toEqual(["b"]);
    cache.release("b");
    expect(cache.keys()).toEqual([]);
  });
});
