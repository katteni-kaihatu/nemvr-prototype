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
import { exporter } from "ipfs-unixfs-exporter";
import { MAX_IMAGE_BYTES, type IceServer, type IpfsInfo } from "@proto/protocol";
import { assembleBlob } from "./blobAssembly";
import { ServingBlockstore, importFileBacked } from "./fileBackedBlockstore";

const CONNECT_TIMEOUT_MS = 10_000;
/** サーバーへの接続が混雑で断られたときの再試行回数と、待ち時間 (ms)。 */
const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_MS = [300, 600, 1200, 2400];

/** データが届かない状態がこの時間続いたら、取得を打ち切る。合計時間ではなく止まっているかで見る (大きなファイルは時間がかかってよい)。 */
const IDLE_TIMEOUT_MS = 30_000;
/** 1 回の取得の合計時間の上限。 */
const MAX_TOTAL_MS = 60 * 60_000;
/** Blob は、このバイト数ごとにまとめて作る (全チャンクを配列に溜めて、メモリを使い切らないように)。 */
const BLOB_BATCH_BYTES = 32 * 1024 * 1024;
/** 最初のブロックが届かないときに、取り消して要求し直すまでの時間。 */
const START_STALL_MS = 5_000;
/** 開始時の停滞で、要求し直す回数の上限 (全体のアイドルタイムアウトで打ち切られる)。 */
const START_STALL_ATTEMPTS = 8;
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
/** 開発時のみ: このピアへは (再) 接続しない (P2P のテスト用)。 */
const blockedPeers = new Set<string>();

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
      connectionGater: {
        denyDialMultiaddr: () => false,
        denyDialPeer: (peerId: { toString: () => string }) => blockedPeers.has(peerId.toString()),
      },
      services: { identify: identify() },
    }),
    // 直前に送ったブロックは、同じ相手から 5 秒間は再送しない (bitswap の既定)。
    // 取得を途中で中断して取り直すと、その要求が無視されて止まるため、窓を 0 にする
    // (このノードは、サーバーや他のブラウザにアップロードしたファイルを配る側にもなる)。
    { doNotResendBlockWindow: 0 },
  ).start();

  // サーバーの Helia ノードに接続する (画像の取得元・中継役)。
  // 入室が重なると、サーバーが一時的に接続を断ることがあるので、少し待って再試行する。
  let dialError: unknown = null;
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    try {
      await helia.libp2p.dial(multiaddr(serverAddr), {
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      dialError = null;
      break;
    } catch (err) {
      dialError = err;
      if (attempt + 1 >= CONNECT_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS[attempt] ?? 2400));
    }
  }
  if (dialError) {
    // 起動した Helia を残すと、次の試行でノードと接続が増え続ける。失敗したら必ず止める
    await helia.stop().catch(() => undefined);
    throw dialError;
  }

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

/** 起動中の Helia ノードの libp2p。 */
export type Libp2pNode = Node["helia"]["libp2p"];

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
  await dialPeerViaRelay(ipfsPeerId, true);
}

/** 中継経由の接続。同期の再試行では、呼び出し側がまとめてログするので黙って失敗できる。 */
async function dialPeerViaRelay(ipfsPeerId: string, logFailure: boolean): Promise<void> {
  const { helia } = await requireNode();
  try {
    await helia.libp2p.dial(multiaddr(`${serverAddr}/p2p-circuit/webrtc/p2p/${ipfsPeerId}`), {
      signal: AbortSignal.timeout(PEER_DIAL_TIMEOUT_MS),
    });
  } catch (err) {
    if (logFailure) console.warn(`[ipfs] direct connection to ${ipfsPeerId} failed: ${describeError(err)}`, err);
  }
}

function requireNode(): Promise<Node> {
  if (!nodePromise) throw new Error("IPFS ノードが起動していません");
  return nodePromise;
}

/** 起動中の Helia ノードの libp2p を返す。未起動なら明確なエラーにする。 */
export async function getLibp2p(): Promise<Libp2pNode> {
  const { helia } = await requireNode();
  return helia.libp2p;
}

/** サーバー (Helia) の libp2p ピア ID。まだ IPFS を起動していなければ null。 */
export function getServerPeerId(): string | null {
  return serverPeerId.length > 0 ? serverPeerId : null;
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
  /** 呼び出し側からの中断 (動画の画面を閉じたときなど)。 */
  signal?: AbortSignal;
}

/**
 * CID の中身を、指定した範囲だけ流す (ブラウザ同士の P2P。Service Worker 経由の動画再生で使う)。
 * 1 チャンクずつ `fs.cat` から受け取る (ブロックは保存しない)。
 */
export async function catContent(
  cid: string,
  options: {
    offset?: number;
    length?: number;
    signal?: AbortSignal;
    /** ブロックを受け取るたびに、送ってきたピアの libp2p ID で呼ばれる */
    onSource?: (peerId: string) => void;
    /**
     * サーバー以外の、直接つながっているブラウザを優先して取得する (動画の P2P 配信)。
     * ブラウザが持っていない場合は、通常の取得 (サーバーなども含む) に切り替える。
     */
    preferBrowserPeers?: boolean;
  } = {},
): Promise<AsyncIterable<Uint8Array>> {
  const { helia, fs } = await requireNode();
  const { onSource, preferBrowserPeers, ...catOptions } = options;
  const progress = onSource
    ? {
        onProgress: (evt: { type: string; detail?: unknown }) => {
          if (evt.type === "bitswap:block") onSource(String((evt.detail as { sender: unknown }).sender));
        },
      }
    : {};
  const root = CID.parse(cid);

  if (preferBrowserPeers) {
    // サーバー (中継・保持役) を除いた、直接つながっているブラウザ
    const peers = [
      ...new Map(
        helia.libp2p
          .getConnections()
          .filter((c) => c.remotePeer.toString() !== serverPeerId)
          .map((c) => [c.remotePeer.toString(), c.remotePeer.toCID()] as const),
      ).values(),
    ];
    if (peers.length > 0) {
      console.info(`[p2p-media] trying ${peers.length} browser peer(s) first`);
      const session = helia.blockstore.createSession(root, { providers: peers, maxProviders: peers.length });
      try {
        const entry = await exporter(root, session, { ...catOptions, ...progress });
        if ((entry.type === "file" || entry.type === "raw") && entry.content != null) {
          console.info("[p2p-media] browser-first fetch succeeded");
          const content = entry.content({ ...catOptions, ...progress });
          return closeWithSession(content, session);
        }
      } catch (err) {
        console.warn("[p2p-media] browser peers could not supply the video; using any peer:", err);
      }
      session.close();
    } else {
      console.info("[p2p-media] no browser peers connected; using any peer");
    }
  }

  return fs.cat(root, { ...catOptions, ...progress });
}

/** 読み終わったら、セッション (ブラウザ優先の取得) を閉じる。 */
async function* closeWithSession(
  content: AsyncIterable<Uint8Array>,
  session: { close: () => void },
): AsyncGenerator<Uint8Array> {
  try {
    yield* content;
  } finally {
    session.close();
  }
}

/**
 * CID の中身を IPFS から取得して Blob にする。上限を超える・取得できない場合は例外を投げる。
 * 全チャンクを配列に溜めず、一定のサイズごとに Blob にまとめていく (ブラウザは大きな Blob をディスクに置ける)。
 * 取得したブロックはブラウザ内に保存しない (流して Blob にするだけ)。
 */
export async function fetchBlob(
  cid: string,
  { maxBytes, idleTimeoutMs = IDLE_TIMEOUT_MS, maxTotalMs = MAX_TOTAL_MS, onProgress, onSource, signal: outer }: FetchBlobOptions,
): Promise<Blob> {
  const { fs } = await requireNode();
  const overall = new AbortController();
  const totalSignal = AbortSignal.any([overall.signal, AbortSignal.timeout(maxTotalMs), ...(outer ? [outer] : [])]);
  let idle = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle = true;
      overall.abort();
    }, idleTimeoutMs);
  };

  const catOptions = onSource
    ? {
        onProgress: (evt: { type: string; detail?: unknown }) => {
          if (evt.type === "bitswap:block") onSource(String((evt.detail as { sender: unknown }).sender));
        },
      }
    : {};

  touch();
  try {
    // 最初のブロックが届かないまま止まることがある (直前に同じブロックを送った相手は、want を無視することがある)。
    // 1 バイトも届いていないときは、取り消して要求し直す (届き始めたら、通常のアイドルタイムアウトに任せる)
    for (let attempt = 0; attempt < START_STALL_ATTEMPTS; attempt++) {
      const attemptAbort = new AbortController();
      const signal = AbortSignal.any([totalSignal, attemptAbort.signal]);
      let received = 0;
      let stallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => attemptAbort.abort(), START_STALL_MS);
      try {
        return await assembleBlob(fs.cat(CID.parse(cid), { ...catOptions, signal }), {
          maxBytes,
          batchBytes: BLOB_BATCH_BYTES,
          onChunk: () => {
            received++;
            if (stallTimer) {
              clearTimeout(stallTimer);
              stallTimer = undefined;
            }
            touch();
          },
          onProgress,
        });
      } catch (err) {
        if (totalSignal.aborted) {
          if (idle) throw new Error("一定時間データが届かず、タイムアウトしました");
          throw err;
        }
        if (received === 0) continue; // 開始時の停滞。要求し直す
        throw err;
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    }
    throw new Error("一定時間データが届かず、タイムアウトしました");
  } finally {
    clearTimeout(idleTimer);
  }
}

/** CID の画像を取得して、テクスチャ読み込み用の blob URL を返す (CID ごとにキャッシュ)。 */
export function getImageUrl(cid: string): Promise<string> {
  let url = imageUrls.get(cid);
  if (!url) {
    // Prefer the server copy. It is available to every client and does not
    // depend on the uploader's browser being online. Fall back to the local
    // IPFS node for images that the server has not pinned yet.
    url = fetch(`/media/${encodeURIComponent(cid)}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`image ${response.status}`);
        return response.blob();
      })
      .catch(() => fetchBlob(cid, { maxBytes: MAX_IMAGE_BYTES }))
      .then((blob) => URL.createObjectURL(blob));
    imageUrls.set(cid, url);
    // 失敗はキャッシュしない
    url.catch(() => imageUrls.delete(cid));
  }
  return url;
}

/**
 * Upload an image (max 5 MiB) to the server before placing it. The server
 * validates and pins it, so other clients do not depend on this browser's
 * IPFS connection or on a slow browser-to-Kubo transfer.
 */
export async function uploadImage(file: Blob): Promise<string> {
  const response = await fetch("/media/upload", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });

  if (!response.ok) {
    let message = `画像をアップロードできませんでした (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const body = (await response.json()) as { cid?: unknown };
  if (typeof body.cid !== "string") throw new Error("サーバーが CID を返しませんでした");
  return body.cid;
}

// 開発時のみ、ブラウザのコンソールや E2E テストから動作確認できるようにする
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __ipfs: unknown }).__ipfs = {
    addImage: addContent,
    addContent,
    getImageUrl,
    fetchBlob,
    /** 内部状態 (いま配っているアップロードの数) */
    state: () => ({ serving: servingStore?.servingCount ?? 0, heldUploads: heldUploads.size }),
    get serverPeerId() { return serverPeerId; },
    /** 開発時のみ: 指定したピアへの再接続を禁止する (P2P の確認用) */
    blockPeer: (peerId: string) => blockedPeers.add(peerId),
    unblockPeer: (peerId: string) => blockedPeers.delete(peerId),
    /** 開発時のみ: 指定したピアとの libp2p 接続を切る (P2P の確認用) */
    hangUp: async (peerId: string) => {
      try {
        const { helia } = await requireNode();
        const peers = helia.libp2p.getConnections().filter((c) => c.remotePeer.toString() === peerId).map((c) => c.remotePeer);
        await Promise.all(peers.map((p) => helia.libp2p.hangUp(p)));
      } catch (err) {
        console.warn(`[ipfs] hangUp failed: ${String(err)}`);
      }
    },
    /** 開発時のみ: いま libp2p でつながっているピアの ID */
    connections: async () => {
      const { helia } = await requireNode();
      return helia.libp2p.getConnections().map((c) => ({ peer: c.remotePeer.toString(), addr: c.remoteAddr.toString() }));
    },
  };
}
