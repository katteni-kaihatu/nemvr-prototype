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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES } from "@proto/protocol";
import { ImageRejected, startIpfs, type IpfsNode } from "./ipfs.js";

// サーバーの Helia ノードと、ブラウザ相当のクライアントノードをプロセス内で動かす結合テスト
const PORT = 18_081;
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

beforeAll(async () => {
  server = await startIpfs(PORT, { fetchTimeoutMs: 2_000 });
  client = await createClient();
  await client.helia.libp2p.dial(
    multiaddr(`/ip4/127.0.0.1/tcp/${PORT}/ws/p2p/${server.info.peerId}`),
  );
}, 30_000);

afterAll(async () => {
  await client?.helia.stop();
  await server?.stop();
});

describe("server IPFS node", () => {
  it("fetches, verifies and pins an image added by a client", async () => {
    const cid = await client.fs.addBytes(png());
    await expect(server.fetchAndPin(cid.toString())).resolves.toBeUndefined();
  }, 15_000);

  it("accepts the same image again (already pinned)", async () => {
    const cid = (await client.fs.addBytes(png(1))).toString();
    await server.fetchAndPin(cid);
    await expect(server.fetchAndPin(cid)).resolves.toBeUndefined();
  }, 15_000);

  it("rejects data that is not an image", async () => {
    const cid = await client.fs.addBytes(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    await expect(server.fetchAndPin(cid.toString())).rejects.toThrow(/対応していない画像形式/);
  }, 15_000);

  it("rejects images over the size limit", async () => {
    const cid = await client.fs.addBytes(png(MAX_IMAGE_BYTES));
    const err = await server.fetchAndPin(cid.toString()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageRejected);
    expect((err as Error).message).toMatch(/大きすぎます/);
  }, 20_000);

  it("rejects a CID that nobody can provide (timeout)", async () => {
    const missing = CID.createV1(0x55, await sha256.digest(new TextEncoder().encode("nobody has this")));
    await expect(server.fetchAndPin(missing.toString())).rejects.toThrow(/取得できませんでした/);
  }, 15_000);
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
