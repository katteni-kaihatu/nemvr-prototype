import { withBitswap } from "@helia/bitswap";
import { withLibp2pLight } from "@helia/libp2p";
import { unixfs } from "@helia/unixfs";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { noise } from "@libp2p/noise";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { yamux } from "@libp2p/yamux";
import { multiaddr } from "@multiformats/multiaddr";
import { createHeliaLight } from "helia";
import { CID } from "multiformats/cid";
import { MAX_IMAGE_BYTES, type IpfsInfo } from "@proto/protocol";

const CONNECT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;

/** ページを開いたホスト名から、サーバーの libp2p (WebSocket) の multiaddr を組み立てる。 */
function serverMultiaddr(info: IpfsInfo): string {
  const host = location.hostname;
  const prefix = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? `/ip4/${host}`
    : host.includes(":")
      ? `/ip6/${host.replace(/^\[|\]$/g, "")}`
      : `/dns4/${host}`;
  return `${prefix}/tcp/${info.wsPort}/ws/p2p/${info.peerId}`;
}

/** WebRTC (ブラウザ同士の直接接続) の接続数を通知するコールバック。 */
export type DirectPeersListener = (count: number) => void;

let serverAddr = "";

async function createNode(info: IpfsInfo, onDirectPeers: DirectPeersListener) {
  serverAddr = serverMultiaddr(info);
  const helia = await withBitswap(
    withLibp2pLight(createHeliaLight(), {
      // 中継経由 / WebRTC で他のブラウザから到達できるようにする
      addresses: { listen: ["/p2p-circuit", "/webrtc"] },
      transports: [webSockets(), webRTC(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // ローカル / 私設ネットワークのアドレスへの接続を許可する (プロトタイプ)
      connectionGater: { denyDialMultiaddr: () => false },
      services: { identify: identify() },
    }),
  ).start();

  // サーバーの Helia ノードに接続する (画像の取得元・中継役)
  await helia.libp2p.dial(multiaddr(serverAddr), {
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  // 直接 (WebRTC) 接続の数を数えて通知する。中継経由のものは数えない
  const countDirect = () =>
    helia.libp2p.getConnections().filter((c) => c.remoteAddr.toString().includes("/webrtc")).length;
  const notify = () => onDirectPeers(countDirect());
  helia.libp2p.addEventListener("connection:open", notify);
  helia.libp2p.addEventListener("connection:close", notify);

  return { helia, fs: unixfs(helia) };
}

type Node = Awaited<ReturnType<typeof createNode>>;

let nodePromise: Promise<Node> | null = null;
const imageUrls = new Map<string, Promise<string>>();

/** この環境では IPFS を使えない (利用者が対処できる原因が分かっている) ことを表す。 */
export class IpfsUnavailableError extends Error {}

/**
 * Helia / libp2p は Web Crypto (`crypto.subtle`) を使う。これは安全なコンテキスト
 * (HTTPS または localhost) でしか提供されないため、`http://<LAN の IP>` で開くと使えない。
 */
function assertSecureContext(): void {
  if (globalThis.isSecureContext && globalThis.crypto?.subtle) return;
  throw new IpfsUnavailableError(
    `このページ (${location.origin}) は安全なコンテキストではないため、IPFS を使えません。` +
      "localhost か HTTPS で開いてください (README 参照)",
  );
}

/** ブラウザ内の IPFS ノードを起動してサーバーに接続する。入室 (welcome) 後に 1 回呼ぶ。 */
export function startIpfs(info: IpfsInfo, onDirectPeers: DirectPeersListener): Promise<void> {
  try {
    assertSecureContext();
  } catch (err) {
    return Promise.reject(err);
  }
  nodePromise ??= createNode(info, onDirectPeers);
  nodePromise.catch(() => {
    nodePromise = null; // 失敗したら次回やり直せるようにする
  });
  return nodePromise.then(() => undefined);
}

export async function stopIpfs(): Promise<void> {
  const pending = nodePromise;
  nodePromise = null;
  for (const url of imageUrls.values()) void url.then((u) => URL.revokeObjectURL(u), () => {});
  imageUrls.clear();
  if (!pending) return;
  try {
    await (await pending).helia.stop();
  } catch {
    // 起動に失敗していた場合など。何もしない
  }
}

/** コンソールで原因が読めるよう、エラーを name: message の文字列にする。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (cause: ${err.cause.name}: ${err.cause.message})` : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}

const RESERVATION_TIMEOUT_MS = 10_000;
const PEER_DIAL_TIMEOUT_MS = 15_000;

/**
 * 他のブラウザから WebRTC で接続してもらえる状態になるのを待って、自分の libp2p ピア ID を返す。
 * 「サーバー (中継) に予約を作って /p2p-circuit/webrtc のアドレスを持つ」ことが条件。
 */
export async function waitForDialable(): Promise<string> {
  const { helia } = await requireNode();
  const t0 = Date.now();
  while (Date.now() - t0 < RESERVATION_TIMEOUT_MS) {
    if (helia.libp2p.getMultiaddrs().some((ma) => ma.toString().includes("/p2p-circuit/webrtc/"))) {
      return helia.libp2p.peerId.toString();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("中継の予約を作成できませんでした");
}

/** 他のブラウザへ、サーバーの中継を使って WebRTC で直接接続する。失敗してもサーバー経由で動き続ける。 */
export async function dialPeer(ipfsPeerId: string): Promise<void> {
  const { helia } = await requireNode();
  try {
    await helia.libp2p.dial(multiaddr(`${serverAddr}/p2p-circuit/webrtc/p2p/${ipfsPeerId}`), {
      signal: AbortSignal.timeout(PEER_DIAL_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[ipfs] direct connection to ${ipfsPeerId} failed: ${describeError(err)}`, err);
  }
}

function requireNode(): Promise<Node> {
  if (!nodePromise) throw new Error("IPFS ノードが起動していません");
  return nodePromise;
}

/** 画像を IPFS に追加して CID (文字列) を返す。追加した内容はこのノードが保持する。 */
export async function addImage(file: Blob): Promise<string> {
  const { fs } = await requireNode();
  const cid = await fs.addBytes(new Uint8Array(await file.arrayBuffer()));
  return cid.toString();
}

/** CID の画像を取得して、テクスチャ読み込み用の blob URL を返す (CID ごとにキャッシュ)。 */
export function getImageUrl(cid: string): Promise<string> {
  let url = imageUrls.get(cid);
  if (!url) {
    url = fetchImageUrl(cid);
    imageUrls.set(cid, url);
    // 失敗はキャッシュしない
    url.catch(() => imageUrls.delete(cid));
  }
  return url;
}

async function fetchImageUrl(cid: string): Promise<string> {
  const { fs } = await requireNode();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of fs.cat(CID.parse(cid), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error("画像が大きすぎます");
    chunks.push(chunk);
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[]));
}

// 開発時のみ、ブラウザのコンソールや E2E テストから動作確認できるようにする
if (import.meta.env.DEV) {
  (window as unknown as { __ipfs: unknown }).__ipfs = { addImage, getImageUrl };
}
