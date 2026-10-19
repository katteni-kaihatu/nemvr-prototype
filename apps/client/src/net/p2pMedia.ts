import { mediaType } from "@proto/protocol";
import { catContent } from "./ipfs";

let available: Promise<boolean> | null = null;

/** 取得元の内訳 (開発時のみ、E2E から確認できるようにする)。 */
const stats = { blocks: {} as Record<string, number> };
if (import.meta.env.DEV) {
  (window as unknown as { __p2pMedia: unknown }).__p2pMedia = {
    ...stats,
    available: () => p2pMediaAvailable(),
    controller: () => !!navigator.serviceWorker.controller,
  };
}

function recordSource(peer: string): void {
  stats.blocks[peer] = (stats.blocks[peer] ?? 0) + 1;
}

/**
 * 動画の P2P 配信に使う Service Worker が使えるか。登録して、このページを制御していることを確かめる。
 * 結果は 1 回だけ調べて覚えておく (使えない環境では、呼び出し側がサーバーの /media に切り替える)。
 */
export function p2pMediaAvailable(): Promise<boolean> {
  if (available) return available;
  // 失敗 (まだ制御されていない) は覚えない。次の機会にやり直す
  available = (async () => {
    if (!("serviceWorker" in navigator)) return false;
    try {
      await navigator.serviceWorker.register("/p2p-media-sw.js");
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return true;
      // 登録直後は、まだこのページを制御していないことがある (clients.claim を待つ)
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(!!navigator.serviceWorker.controller), 3000);
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });
    } catch (err) {
      console.warn("[p2p-media] service worker unavailable:", err);
      return false;
    }
  })();
  void available.then((ok) => {
    if (!ok) available = null;
  });
  return available;
}

export interface P2pMediaSource {
  /** `<video src>` に渡す URL (Service Worker が横取りして、IPFS から流す) */
  url: string;
  /** 配信をやめる (動画を閉じたとき)。 */
  stop: () => void;
}

interface StreamEntry {
  /** `fs.cat` のイテレーター (open の準備中は Promise) */
  iterator: Promise<AsyncIterator<Uint8Array>>;
  cancelled: boolean;
}

/**
 * 動画を、ブラウザ内の IPFS (bitswap) から P2P で流すための口を登録する。
 * 返した URL を `<video src>` にすると、Range 要求ごとに、このページの Helia から必要な範囲だけを流す
 * (全体は取得しない。シークもできる)。
 * Service Worker が使えない環境では null (呼び出し側は、サーバーの `/media` などに切り替える)。
 */
export async function registerP2pMedia(cid: string, size: number, name: string): Promise<P2pMediaSource | null> {
  if (!(await p2pMediaAvailable())) {
    console.warn("[p2p-media] service worker is not available");
    return null;
  }
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    console.warn("[p2p-media] no service worker controller");
    return null;
  }

  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const requests = new Map<string, StreamEntry>();
  let stopped = false;
  let markRegistered: () => void = () => {};
  const registered = new Promise<void>((resolve) => {
    markRegistered = resolve;
  });

  const post = (message: unknown, transfer: Transferable[] = []) => {
    try {
      channel.port1.postMessage(message, transfer);
    } catch {
      // ポートが閉じられた
    }
  };

  channel.port1.onmessage = async (e: MessageEvent) => {
    const msg = e.data as { type?: string; reqId?: string; start?: number; end?: number; message?: string };
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "registered") {
      markRegistered();
      return;
    }
    const reqId = msg.reqId;
    if (!reqId) return;

    if (msg.type === "open") {
      const start = Number.isFinite(msg.start) ? (msg.start as number) : 0;
      const end = Number.isFinite(msg.end) ? (msg.end as number) : size - 1;
      requests.set(reqId, {
        iterator: catContent(cid, {
          offset: start,
          length: end - start + 1,
          onSource: recordSource,
          preferBrowserPeers: true,
        }).then((it) => it[Symbol.asyncIterator]()),
        cancelled: false,
      });
      return;
    }

    const entry = requests.get(reqId);
    if (!entry) return;

    if (msg.type === "cancel") {
      entry.cancelled = true;
      requests.delete(reqId);
      try {
        await (await entry.iterator).return?.();
      } catch {
        // すでに終わっている
      }
      return;
    }

    if (msg.type === "pull") {
      if (entry.cancelled || stopped) return;
      try {
        const iterator = await entry.iterator;
        const next = await iterator.next();
        if (entry.cancelled || stopped) return;
        if (next.done) {
          requests.delete(reqId);
          post({ type: "end", reqId });
        } else {
          // 転送するので、バッファをコピーする (元のバッファを共有しない)
          const bytes = next.value.slice();
          post({ type: "chunk", reqId, bytes: bytes.buffer }, [bytes.buffer]);
        }
      } catch (err) {
        requests.delete(reqId);
        post({ type: "error", reqId, message: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  channel.port1.start();
  controller.postMessage({ type: "register", id, size, contentType: mediaType(name) }, [channel.port2]);

  // 登録が終わるまで待つ (先に <video> が URL を要求すると、SW が 404 を返してしまう)
  await Promise.race([registered, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);

  return {
    url: `/p2p-media/${id}`,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        controller.postMessage({ type: "unregister", id });
      } catch {
        // ignore
      }
      for (const entry of requests.values()) {
        entry.cancelled = true;
        void entry.iterator
          .then((it) => it.return?.())
          .catch(() => {
            // ignore
          });
      }
      requests.clear();
      channel.port1.close();
    },
  };
}
