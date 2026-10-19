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
import { MAX_IMAGE_BYTES, type IceServer, type IpfsInfo } from "@proto/protocol";
import { assembleBlob } from "./blobAssembly";
import { ServingBlockstore, importFileBacked } from "./fileBackedBlockstore";

const CONNECT_TIMEOUT_MS = 10_000;
/** データが届かない状態がこの時間続いたら、取得を打ち切る。合計時間ではなく止まっているかで見る (大きなファイルは時間がかかってよい)。 */
const IDLE_TIMEOUT_MS = 30_000;
/** 1 回の取得の合計時間の上限。 */
const MAX_TOTAL_MS = 60 * 60_000;
/** Blob は、このバイト数ごとにまとめて作る (全チャンクを配列に溜めて、メモリを使い切らないように)。 */
const BLOB_BATCH_BYTES = 32 * 1024 * 1024;
/** アップロードしたファイルは、サーバーが取り終える (object_added が届く) まで配る。進捗が止まってからこの時間で諦める。 */
const UPLOAD_HOLD_IDLE_MS = 2 * 60_000;

/** ページを開いたホスト名から、サーバーの libp2p (WebSocket) の multiaddr を組み立てる。 */
function serverMultiaddr(info: IpfsInfo): string {
  const host = location.hostname;
  const prefix = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? `/ip4/${host}`
    : host.includes(":")
      ? `/ip6/${host.replace(/^\[|\]$/g, "")}`
      : `/dns4/${host}`;
  // HTTPS のページからは TLS (wss) でしか接続できない。リバースプロキシが TLS を終端する前提
  const transport = location.protocol === "https:" ? "tls/ws" : "ws";
  return `${prefix}/tcp/${info.wsPort}/${transport}/p2p/${info.peerId}`;
}

/** WebRTC (ブラウザ同士の直接接続) の接続数を通知するコールバック。 */
export type DirectPeersListener = (count: number) => void;

let serverAddr = "";
/** サーバーの libp2p ピア ID (ブロックの取得元が、サーバーかどうかを見分けるため)。 */
let serverPeerId = "";
/** 他のユーザーの libp2p ピア ID → 表示名 (取得元の表示用)。 */
const peerNames = new Map<string, string>();
/** 起動したノードの libp2p (取得元の接続の種類を調べるため)。 */
let libp2pRef: { getConnections: () => { remotePeer: { toString: () => string }; remoteAddr: { toString: () => string } }[] } | null = null;

/** 他のユーザーの libp2p ピア ID に、表示名を結び付ける (ダウンロードの取得元に名前を出すため)。 */
export function rememberPeerName(ipfsPeerId: string, name: string): void {
  peerNames.set(ipfsPeerId, name);
}

export type SourceKind = "server" | "direct" | "relay" | "unknown";

export interface FetchSource {
  /** 送ってきたピアの libp2p ID */
  peer: string;
  /** 表示用の名前 (サーバー / ユーザー名 / ID の末尾) */
  label: string;
  /** サーバー / ブラウザ同士の直接 (WebRTC) / 中継 (circuit relay) 経由 */
  kind: SourceKind;
  /** 受け取ったブロックの数 */
  blocks: number;
}

/** 送ってきたピアが、サーバーか、他のブラウザか (直接か中継か) を調べる。 */
function classifySource(peer: string): { label: string; kind: SourceKind } {
  if (peer === serverPeerId) return { label: "サーバー", kind: "server" };
  const name = peerNames.get(peer) ?? peer.slice(-8);
  const addrs = (libp2pRef?.getConnections() ?? []).filter((c) => c.remotePeer.toString() === peer).map((c) => c.remoteAddr.toString());
  if (addrs.some((a) => a.includes("/webrtc"))) return { label: `${name} (直接 WebRTC)`, kind: "direct" };
  if (addrs.length > 0) return { label: `${name} (中継)`, kind: "relay" };
  return { label: name, kind: "unknown" };
}

/** ブロックを送ってきたピアごとの数 (取得中に数えたもの) を、表示用にまとめる。多い順。 */
export function summarizeSources(counts: Map<string, number>): FetchSource[] {
  return [...counts]
    .map(([peer, blocks]) => ({ peer, blocks, ...classifySource(peer) }))
    .sort((a, b) => b.blocks - a.blocks);
}

/**
 * WebRTC の設定。サーバーが TURN を配っていればそれを使う (NAT 越えできないときは TURN で中継される)。
 * 配られていなければ libp2p の既定 (公開 STUN のみ) のまま。
 * `?ice=relay` を付けて開くと中継 (TURN) だけを使う。TURN の動作確認・診断用。
 */
function webRtcInit(iceServers: IceServer[] | undefined) {
  const relayOnly = new URLSearchParams(location.search).get("ice") === "relay";
  if (!iceServers?.length && !relayOnly) return undefined;
  const rtcConfiguration: RTCConfiguration = {};
  if (iceServers?.length) rtcConfiguration.iceServers = iceServers;
  if (relayOnly) rtcConfiguration.iceTransportPolicy = "relay";
  return { rtcConfiguration };
}

async function createNode(
  info: IpfsInfo,
  iceServers: IceServer[] | undefined,
  onDirectPeers: DirectPeersListener,
) {
  serverAddr = serverMultiaddr(info);
  serverPeerId = info.peerId;
  // ブロックは保存しない。アップロード中のファイルは元のファイルから直接配り、取得したブロックは流して捨てる。
  // (IndexedDB に保存すると、Firefox で 1MiB あたり 0.2〜0.3 秒かかり、サーバーが数十ブロックを一度に要求すると
  //  応答が間に合わず止まった。メモリに保存すると、ファイルのサイズ分のメモリを使う)
  const serving = new ServingBlockstore();
  servingStore = serving;
  const helia = await withBitswap(
    withLibp2pLight(createHeliaLight({ blockstore: serving }), {
      // 中継経由 / WebRTC で他のブラウザから到達できるようにする
      addresses: { listen: ["/p2p-circuit", "/webrtc"] },
      transports: [webSockets(), webRTC(webRtcInit(iceServers)), circuitRelayTransport()],
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

  libp2pRef = helia.libp2p;
  return { helia, fs: unixfs(helia), serving };
}

type Node = Awaited<ReturnType<typeof createNode>>;

let nodePromise: Promise<Node> | null = null;
/** アップロード中のファイルを配るブロックストア (ノードを起動したら入る)。 */
let servingStore: ServingBlockstore | null = null;
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
export function startIpfs(
  info: IpfsInfo,
  iceServers: IceServer[] | undefined,
  onDirectPeers: DirectPeersListener,
): Promise<void> {
  try {
    assertSecureContext();
  } catch (err) {
    return Promise.reject(err);
  }
  nodePromise ??= createNode(info, iceServers, onDirectPeers);
  nodePromise.catch(() => {
    nodePromise = null; // 失敗したら次回やり直せるようにする
  });
  return nodePromise.then(() => undefined);
}

export async function stopIpfs(): Promise<void> {
  const pending = nodePromise;
  nodePromise = null;
  servingStore = null;
  for (const timer of heldUploads.values()) clearTimeout(timer);
  heldUploads.clear();
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

// ---- アップロードしたファイルを、サーバーが取り終えるまで配る ----

const heldUploads = new Map<string, ReturnType<typeof setTimeout>>();
/** 時間で諦めずに配り続けているもの (keepServing)。進捗の通知 (holdUpload) が来ても、期限付きに戻さない。 */
const pinnedUploads = new Set<string>();

/**
 * アップロードしたファイルを、サーバーが取り終えるまで配り続ける。
 * 進捗の通知が来るたびに呼んで、延ばす。通知が途絶えたら (サーバーが断った・失敗した) 諦める。
 */
export function holdUpload(cid: string): void {
  if (pinnedUploads.has(cid)) return;
  clearTimeout(heldUploads.get(cid));
  heldUploads.set(cid, setTimeout(() => releaseUpload(cid), UPLOAD_HOLD_IDLE_MS));
}

/**
 * 配り続ける (進捗が来なくても、時間で諦めない)。大きなファイルは、サーバーが取り終えるまで時間がかかるので、
 * 置いた人が、サーバーが保持するまで (または削除されるまで) 配り続ける。やめるときは releaseUpload。
 */
export function keepServing(cid: string): void {
  pinnedUploads.add(cid);
  clearTimeout(heldUploads.get(cid));
  heldUploads.delete(cid);
}

/** このブラウザが、いまこの CID を配っているか (自分が置いたファイルは、サーバーを通さずに自分から取れる)。 */
export function isServing(cid: string): boolean {
  return servingStore?.isServing(cid) ?? false;
}

/** サーバーが取り終えた (または、もう取らない) ので、配るのをやめて、索引を捨てる。 */
export function releaseUpload(cid: string): void {
  pinnedUploads.delete(cid);
  clearTimeout(heldUploads.get(cid));
  heldUploads.delete(cid);
  servingStore?.stop(cid);
}

export interface AddContentOptions {
  /** 読み込み済みのバイト数と、全体のバイト数 */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

/**
 * 画像・ファイルを IPFS に取り込んで CID (文字列) を返す。
 * ファイルを丸ごとメモリに読まず、ブロックも保存しない。「どのブロックがファイルのどこか」の索引だけを作り、
 * サーバーが取りに来たら元のファイルから読んで渡す (数 GB でも、メモリもディスクも使わない)。
 * サーバーが取り終える (object_added が届く) まで、このファイルを読み続けられる必要がある。
 */
export async function addContent(file: Blob, { onProgress }: AddContentOptions = {}): Promise<string> {
  await requireNode();
  const { cid, blockstore } = await importFileBacked(file, { onProgress });
  const root = cid.toString();
  servingStore?.serve(root, blockstore);
  holdUpload(root);
  return root;
}

export interface FetchBlobOptions {
  /** この大きさを超えたら中止する (バイト) */
  maxBytes: number;
  /** データが届かない状態がこの時間 (ミリ秒) 続いたら中止する。 */
  idleTimeoutMs?: number;
  /** 合計の時間の上限 (ミリ秒) */
  maxTotalMs?: number;
  /** 取得したバイト数の途中経過 */
  onProgress?: (loadedBytes: number) => void;
  /** ブロックを 1 つ受け取るたびに、送ってきたピアの libp2p ID で呼ばれる (取得元の内訳を知るため)。 */
  onSource?: (peerId: string) => void;
}

/**
 * CID の中身を IPFS から取得して Blob にする。上限を超える・取得できない場合は例外を投げる。
 * 全チャンクを配列に溜めず、一定のサイズごとに Blob にまとめていく (ブラウザは大きな Blob をディスクに置ける)。
 * 取得したブロックはブラウザ内に保存しない (流して Blob にするだけ)。
 */
export async function fetchBlob(
  cid: string,
  { maxBytes, idleTimeoutMs = IDLE_TIMEOUT_MS, maxTotalMs = MAX_TOTAL_MS, onProgress, onSource }: FetchBlobOptions,
): Promise<Blob> {
  const { fs } = await requireNode();
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(maxTotalMs)]);
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      abort.abort();
    }, idleTimeoutMs);
  };

  touch();
  try {
    const catOptions = {
      signal,
      ...(onSource
        ? {
            onProgress: (evt: { type: string; detail?: unknown }) => {
              if (evt.type === "bitswap:block") onSource(String((evt.detail as { sender: unknown }).sender));
            },
          }
        : {}),
    };
    return await assembleBlob(fs.cat(CID.parse(cid), catOptions), {
      maxBytes,
      batchBytes: BLOB_BATCH_BYTES,
      onChunk: touch,
      onProgress,
    });
  } catch (err) {
    if (idle) throw new Error("一定時間データが届かず、タイムアウトしました");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** CID の画像を取得して、テクスチャ読み込み用の blob URL を返す (CID ごとにキャッシュ)。 */
export function getImageUrl(cid: string): Promise<string> {
  let url = imageUrls.get(cid);
  if (!url) {
    url = fetchBlob(cid, { maxBytes: MAX_IMAGE_BYTES }).then((blob) => URL.createObjectURL(blob));
    imageUrls.set(cid, url);
    // 失敗はキャッシュしない
    url.catch(() => imageUrls.delete(cid));
  }
  return url;
}

// 開発時のみ、ブラウザのコンソールや E2E テストから動作確認できるようにする
if (import.meta.env.DEV) {
  (window as unknown as { __ipfs: unknown }).__ipfs = {
    addImage: addContent,
    addContent,
    getImageUrl,
    fetchBlob,
    /** 内部状態 (いま配っているアップロードの数) */
    state: () => ({ serving: servingStore?.servingCount ?? 0, heldUploads: heldUploads.size }),
  };
}
