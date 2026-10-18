import { withBitswap } from "@helia/bitswap";
import { withLibp2pLight } from "@helia/libp2p";
import { unixfs } from "@helia/unixfs";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import { noise } from "@libp2p/noise";
import { webSockets } from "@libp2p/websockets";
import { yamux } from "@libp2p/yamux";
import { multiaddr } from "@multiformats/multiaddr";
import { createHeliaLight } from "helia";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentRejected, startIpfs, type FetchLimits, type IpfsNode } from "./ipfs.js";

// サーバーの Helia ノードと、ブラウザ相当のクライアントノードをプロセス内で動かす結合テスト
const PORT = 18_081;
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const LIMITS: FetchLimits = { maxBytes: 1024 * 1024, idleTimeoutMs: 2_000, tooLargeMessage: "too large" };

let blockDir: string;

/** ディレクトリ以下の全ファイルの合計バイト数。 */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

let server: IpfsNode;
let client: Awaited<ReturnType<typeof createClient>>;

async function createClient() {
  const helia = await withBitswap(
    withLibp2pLight(createHeliaLight(), {
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: { denyDialMultiaddr: () => false },
      services: { identify: identify() },
    }),
  ).start();
  return { helia, fs: unixfs(helia) };
}

const png = (extra = 0) => Uint8Array.from([...PNG_HEADER, ...new Array<number>(32 + extra).fill(7)]);

/**
 * 内容がテストごと・ブロックごとに違うバイト列。
 * 同じ内容のブロックは IPFS で 1 つにまとめられるので、乱数で埋める (ディスクに書かれる量を正しく測るため)。
 */
const unique = (size: number) => new Uint8Array(randomBytes(size));

beforeAll(async () => {
  blockDir = await mkdtemp(join(tmpdir(), "proto-blocks-test-"));
  server = await startIpfs(PORT, { blockstoreDir: blockDir });
  client = await createClient();
  await client.helia.libp2p.dial(
    multiaddr(`/ip4/127.0.0.1/tcp/${PORT}/ws/p2p/${server.info.peerId}`),
  );
}, 30_000);

afterAll(async () => {
  await client?.helia.stop();
  await server?.stop();
  await rm(blockDir, { recursive: true, force: true });
});

describe("server IPFS node", () => {
  it("fetches content added by a client and reports the measured size and head", async () => {
    const data = png();
    const cid = (await client.fs.addBytes(data)).toString();
    const fetched = await server.fetchVerified(cid, LIMITS);
    expect(fetched.size).toBe(data.length);
    expect([...fetched.head.slice(0, 8)]).toEqual(PNG_HEADER);
  }, 15_000);

  it("measures larger multi-block files (not just the root node)", async () => {
    const data = unique(2.5 * 1024 * 1024 | 0); // 1MiB のチャンクで 3 ブロックになる
    const cid = (await client.fs.addBytes(data)).toString();
    const fetched = await server.fetchVerified(cid, { ...LIMITS, maxBytes: 5 * 1024 * 1024, idleTimeoutMs: 10_000 });
    expect(fetched.size).toBe(data.length);
    expect(fetched.head).toHaveLength(16);
  }, 30_000);

  it("rejects content over the limit before fetching it all", async () => {
    const cid = (await client.fs.addBytes(unique(2_000))).toString();
    const err = await server.fetchVerified(cid, { ...LIMITS, maxBytes: 1_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentRejected);
    expect((err as Error).message).toBe("too large");
  }, 15_000);

  it("rejects a directory", async () => {
    const file = await client.fs.addBytes(unique(100));
    const emptyDir = await client.fs.addDirectory();
    const dir = await client.fs.cp(file, emptyDir, "a.txt");
    await expect(server.fetchVerified(dir.toString(), LIMITS)).rejects.toThrow(/ディレクトリ/);
  }, 15_000);

  it("rejects a CID that nobody can provide (timeout)", async () => {
    const missing = CID.createV1(0x55, await sha256.digest(new TextEncoder().encode("nobody has this")));
    await expect(server.fetchVerified(missing.toString(), { ...LIMITS, idleTimeoutMs: 1_500 })).rejects.toThrow(/取得できませんでした/);
  }, 15_000);

  it("reports progress while fetching, ending at the full size", async () => {
    const data = unique(2.5 * 1024 * 1024 | 0);
    const cid = (await client.fs.addBytes(data)).toString();
    const calls: [number, number][] = [];
    const fetched = await server.fetchVerified(cid, {
      ...LIMITS,
      maxBytes: 5 * 1024 * 1024,
      idleTimeoutMs: 10_000,
      onProgress: (loaded, declared) => calls.push([loaded, declared]),
    });
    expect(calls.length).toBeGreaterThanOrEqual(2); // ブロックごとに通知される
    expect(calls.at(-1)).toEqual([fetched.size, data.length]); // 最後は全体、宣言サイズも一致
    expect(calls.map((c) => c[0])).toEqual([...calls.map((c) => c[0])].sort((a, b) => a - b)); // 増えていく
  }, 30_000);

  it("lets onDeclaredSize reject before any content is fetched", async () => {
    const cid = (await client.fs.addBytes(unique(3_000_000))).toString();
    let progressCalls = 0;
    const err = await server
      .fetchVerified(cid, {
        ...LIMITS,
        maxBytes: 5 * 1024 * 1024,
        onDeclaredSize: (declared) => {
          expect(declared).toBe(3_000_000);
          throw new ContentRejected("no space");
        },
        onProgress: () => progressCalls++,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentRejected);
    expect((err as Error).message).toBe("no space");
    expect(progressCalls).toBe(0); // 中身は取得していない
  }, 15_000);

  it("keeps content on disk (not in memory), and frees the disk after unpin + gc", async () => {
    const size = 3 * 1024 * 1024;
    const before = await dirSize(blockDir);
    const cid = (await client.fs.addBytes(unique(size))).toString();
    await server.fetchVerified(cid, { ...LIMITS, maxBytes: 5 * 1024 * 1024, idleTimeoutMs: 10_000 });
    await server.pin(cid);
    const during = await dirSize(blockDir);
    expect(during - before).toBeGreaterThanOrEqual(size); // ブロックがファイルとして書かれている

    await server.unpin(cid);
    await server.gc();
    const after = await dirSize(blockDir);
    expect(after - before).toBeLessThan(size / 10); // ディスクが空く
  }, 30_000);

  it("pin is idempotent", async () => {
    const cid = (await client.fs.addBytes(unique(300))).toString();
    await server.fetchVerified(cid, LIMITS);
    await server.pin(cid);
    await expect(server.pin(cid)).resolves.toBeUndefined();
    await server.unpin(cid);
    await expect(server.unpin(cid)).resolves.toBeUndefined(); // pin していないものを外してもエラーにしない
  }, 15_000);

  it("gc frees unpinned content but keeps pinned content", async () => {
    const kept = (await client.fs.addBytes(unique(4_000))).toString();
    const dropped = (await client.fs.addBytes(unique(4_000))).toString();
    await server.fetchVerified(kept, LIMITS);
    await server.fetchVerified(dropped, LIMITS);
    await server.pin(kept);
    await server.pin(dropped);
    expect(await server.has(kept)).toBe(true);
    expect(await server.has(dropped)).toBe(true);

    await server.unpin(dropped);
    await server.gc();
    expect(await server.has(kept)).toBe(true);
    expect(await server.has(dropped)).toBe(false); // メモリが空く
  }, 20_000);
});

describe("blockstore directory", () => {
  it("is emptied at startup (state does not survive a restart, so leftover blocks would only leak disk)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proto-blocks-wipe-"));
    try {
      await mkdir(join(dir, "AA"), { recursive: true });
      await writeFile(join(dir, "AA", "stale.data"), "leftover from a previous run");
      await writeFile(join(dir, "stray.txt"), "x");

      const node = await startIpfs(18_083, { blockstoreDir: dir });
      try {
        expect(await readdir(dir)).toEqual([]);
      } finally {
        await node.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("circuit relay reservations", () => {
  it("lets more clients than the default limit (15) make a reservation", async () => {
    const { createLibp2p } = await import("libp2p");
    const { circuitRelayTransport } = await import("@libp2p/circuit-relay-v2");
    const relayAddr = multiaddr(`/ip4/127.0.0.1/tcp/${PORT}/ws/p2p/${server.info.peerId}`);

    // 同じホストからの受信接続は 1 秒あたり 5 件までに制限される (libp2p の既定) ため、間隔を空けて接続する
    const clients: Libp2p[] = [];
    for (let i = 0; i < 18; i++) {
      const node = await createLibp2p({
        addresses: { listen: ["/p2p-circuit"] },
        transports: [webSockets(), circuitRelayTransport()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionGater: { denyDialMultiaddr: () => false },
        services: { identify: identify() },
      });
      await node.dial(relayAddr);
      clients.push(node);
      await new Promise((r) => setTimeout(r, 300));
    }
    try {
      // 予約に成功すると /p2p-circuit のアドレスを持つ
      const deadline = Date.now() + 8_000;
      const reserved = () => clients.filter((c) => c.getMultiaddrs().some((a) => a.toString().includes("/p2p-circuit"))).length;
      while (reserved() < clients.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(reserved()).toBe(clients.length);
    } finally {
      await Promise.all(clients.map((c) => c.stop()));
    }
  }, 60_000);
});
