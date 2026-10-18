import { withBitswap } from "@helia/bitswap";
import { withLibp2pLight } from "@helia/libp2p";
import { unixfs } from "@helia/unixfs";
import { noise } from "@libp2p/noise";
import { yamux } from "@libp2p/yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createHeliaLight } from "helia";
import { CID } from "multiformats/cid";
import { MAX_IMAGE_BYTES, type IpfsInfo } from "@proto/protocol";
import { sniffImageType } from "./images.js";

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const SNIFF_BYTES = 16;

/** クライアントにそのまま見せてよいメッセージを持つエラー。 */
export class ImageRejected extends Error {}

export interface IpfsNode {
  info: IpfsInfo;
  /**
   * CID の中身を IPFS から取得して検証 (サイズ上限・画像形式) し、通れば pin する。
   * 通らなければ ImageRejected を投げる。
   */
  fetchAndPin(cid: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * サーバー側の Helia ノード。役割は次の 3 つ。
 * - libp2p の WebSocket で待ち受け、ブラウザの Helia ノードの接続先 (bootstrap) になる
 * - circuit relay でブラウザ同士の接続 (WebRTC) の仲介をする
 * - 置かれた画像を取得して pin し、アップロードした人が退室した後も配信し続ける
 */
export async function startIpfs(
  wsPort: number,
  {
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    host = "0.0.0.0",
    publicPort = wsPort,
  }: {
    fetchTimeoutMs?: number;
    /** libp2p の WebSocket を待ち受けるアドレス。リバースプロキシの背後なら 127.0.0.1。 */
    host?: string;
    /** ブラウザから見たポート (リバースプロキシで変わる場合)。クライアントへ `welcome` で伝える。 */
    publicPort?: number;
  } = {},
): Promise<IpfsNode> {
  const helia = await withBitswap(
    withLibp2pLight(createHeliaLight(), {
      addresses: { listen: [`/ip4/${host}/tcp/${wsPort}/ws`] },
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // ローカル / 私設ネットワークのアドレスへの接続を許可する (プロトタイプ)
      connectionGater: { denyDialMultiaddr: () => false },
      // リバースプロキシの背後では全クライアントが同じホスト (127.0.0.1) から来るように見える。
      // 既定の「同一ホストから 1 秒に 5 接続まで」だと、入室が重なっただけで拒否されてしまう
      connectionManager: { inboundConnectionThreshold: 100 },
      services: {
        identify: identify(),
        relay: circuitRelayServer({
          // 予約は切断しても有効期限 (既定 2 時間) まで残り、ブラウザはページを開くたびに
          // 新しいピア ID になる。既定の 15 件だとすぐ埋まり、新しい人の直接接続ができなくなる
          reservations: { maxReservations: 1000 },
        }),
      },
    }),
  ).start();

  const fs = unixfs(helia);

  async function fetchAndPin(cidString: string): Promise<void> {
    const cid = CID.parse(cidString);
    const limit = new AbortController();
    const signal = AbortSignal.any([limit.signal, AbortSignal.timeout(fetchTimeoutMs)]);

    let size = 0;
    const head = new Uint8Array(SNIFF_BYTES);
    let headLength = 0;
    let tooLarge = false;
    try {
      for await (const chunk of fs.cat(cid, { signal })) {
        if (headLength < SNIFF_BYTES) {
          const part = chunk.subarray(0, SNIFF_BYTES - headLength);
          head.set(part, headLength);
          headLength += part.length;
        }
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          tooLarge = true;
          limit.abort();
          break;
        }
      }
    } catch (err) {
      if (tooLarge) throw new ImageRejected("画像が大きすぎます");
      if (signal.aborted) throw new ImageRejected("画像を IPFS から取得できませんでした (タイムアウト)");
      console.warn("[ipfs] fetch failed:", err);
      throw new ImageRejected("画像を IPFS から取得できませんでした");
    }
    if (tooLarge) throw new ImageRejected("画像が大きすぎます");
    if (!sniffImageType(head.subarray(0, headLength))) {
      throw new ImageRejected("対応していない画像形式です (PNG / JPEG / GIF / WebP)");
    }

    // 同じ画像が再び置かれることがある (pin 済みの CID を再度 add するとエラーになる)
    if (await helia.pins.isPinned(cid)) return;
    // pins.add はジェネレーターなので最後まで回す
    for await (const _ of helia.pins.add(cid)) {
      // 何もしない
    }
  }

  return {
    info: { peerId: helia.libp2p.peerId.toString(), wsPort: publicPort },
    fetchAndPin,
    stop: async () => {
      await helia.stop();
    },
  };
}
