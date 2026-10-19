/**
 * ブラウザ同士の IPFS (bitswap) で、動画をストリーミングするための Service Worker。
 *
 * `<video>` は HTTP の URL しか再生できないので、`/p2p-media/<id>` への要求 (Range を含む) をこの SW が横取りし、
 * ページ (ブラウザ内の Helia ノード) から受け取ったチャンクを、HTTP のレスポンスとして流す。
 * ページは `register` で CID と範囲の読み出し口 (MessagePort) を登録する。
 *
 * やりとり (reqId ごと):
 *   SW → ページ: open (start, end) / pull / cancel
 *   ページ → SW: chunk (bytes) / end / error
 * `pull` に 1 つずつ `chunk` を返すことで、動画の再生速度に合わせた背圧がかかる。
 */

const streams = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "register" && typeof data.id === "string") {
    const port = event.ports[0];
    if (!port) return;
    const entry = {
      port,
      size: Number(data.size) || 0,
      type: typeof data.contentType === "string" ? data.contentType : "application/octet-stream",
      requests: new Map(),
    };
    streams.set(data.id, entry);
    port.onmessage = (e) => onFromPage(entry, e.data);
    port.start?.();
    port.postMessage({ type: "registered" });
    return;
  }

  if (data.type === "unregister" && typeof data.id === "string") {
    const entry = streams.get(data.id);
    if (!entry) return;
    for (const [, req] of entry.requests) {
      try {
        req.controller.close();
      } catch {
        // すでに閉じている
      }
    }
    entry.requests.clear();
    try {
      entry.port.close();
    } catch {
      // ignore
    }
    streams.delete(data.id);
  }
});

function onFromPage(entry, msg) {
  if (!msg || typeof msg !== "object") return;
  const req = entry.requests.get(msg.reqId);
  if (!req) return;
  if (msg.type === "chunk") {
    try {
      req.controller.enqueue(new Uint8Array(msg.bytes));
    } catch {
      // ストリームが閉じられた
      entry.requests.delete(msg.reqId);
    }
  } else if (msg.type === "end") {
    entry.requests.delete(msg.reqId);
    try {
      req.controller.close();
    } catch {
      // ignore
    }
  } else if (msg.type === "error") {
    entry.requests.delete(msg.reqId);
    try {
      req.controller.error(new Error(msg.message || "stream error"));
    } catch {
      // ignore
    }
  }
}

/** `Range: bytes=...` を解釈する。範囲なしは null、不正は "invalid"。 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return "invalid";
  let start;
  let end;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start) || start < 0) return "invalid";
    end = endText === "" ? size - 1 : Number(endText);
    if (!Number.isSafeInteger(end) || end < start) return "invalid";
    end = Math.min(end, size - 1);
  }
  if (size <= 0 || start >= size) return "invalid";
  return { start, end };
}

function respond(request, entry) {
  const range = parseRange(request.headers.get("range"), entry.size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${entry.size}` },
    });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : entry.size - 1;
  const headers = {
    "Content-Type": entry.type,
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "no-store",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${entry.size}` } : {}),
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const reqId = crypto.randomUUID();
  const stream = new ReadableStream(
    {
      start(controller) {
        entry.requests.set(reqId, { controller });
        entry.port.postMessage({ type: "open", reqId, start, end });
      },
      pull() {
        if (entry.requests.has(reqId)) entry.port.postMessage({ type: "pull", reqId });
      },
      cancel() {
        entry.requests.delete(reqId);
        entry.port.postMessage({ type: "cancel", reqId });
      },
    },
    { highWaterMark: 2 },
  );
  return new Response(stream, { status: range ? 206 : 200, headers });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/p2p-media/")) return;
  const id = url.pathname.slice("/p2p-media/".length);
  const entry = streams.get(id);
  if (!entry) {
    event.respondWith(new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } }));
    return;
  }
  event.respondWith(respond(event.request, entry));
});
