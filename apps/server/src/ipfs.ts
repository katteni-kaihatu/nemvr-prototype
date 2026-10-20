import { withBitswap } from "@helia/bitswap";
import { withLibp2pLight } from "@helia/libp2p";
import { unixfs } from "@helia/unixfs";
import { noise } from "@libp2p/noise";
import { yamux } from "@libp2p/yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { FsBlockstore } from "blockstore-fs";
import { createHeliaLight } from "helia";
import { mkdir, rm } from "node:fs/promises";
import { CID } from "multiformats/cid";
import type { IpfsInfo } from "@proto/protocol";

const SNIFF_BYTES = 16;

/** クライアントにそのまま見せてよいメッセージを持つエラー。 */
export class ContentRejected extends Error {}

/** 取得するときの制限。 */
export interface FetchLimits {
  /** この大きさを超えたら取得を打ち切る (バイト) */
  maxBytes: number;
  /**
   * データが届かない状態がこの時間 (ミリ秒) 続いたら打ち切る。
   * 合計時間ではなく、止まっているかどうかで判断する (数 GB の転送は、動いている限り時間がかかってよい)。
   */
  idleTimeoutMs: number;
  /** 合計の時間の上限 (ミリ秒)。少しずつ送って居座られるのを防ぐ。既定は 1 時間。 */
  maxTotalMs?: number;
  /** 上限を超えたときに見せるメッセージ */
  tooLargeMessage: string;
  /**
   * ルートのブロックから分かった、宣言されたサイズ (バイト)。ここで ContentRejected を投げると、中身を取得せずに拒否できる
   * (容量の事前確認に使う)。宣言は偽れるので、取得中の実測の上限 (maxBytes) は別に守る。
   */
  onDeclaredSize?: (bytes: number) => void;
  /** 取得したバイト数の途中経過 (チャンクごとに呼ばれる)。declared は宣言されたサイズ。 */
  onProgress?: (loadedBytes: number, declaredBytes: number) => void;
  /**
   * 先頭の数バイト (種類の判定用) だけを取得して返す。中身の全部は取得しないので、大きなファイルでも一瞬で終わる。
   * 返す `size` は、実測ではなく宣言されたサイズ (ルートのブロックのメタデータ)。
   */
  headOnly?: boolean;
  /** 最初のデータがこの時間 (ミリ秒) 届かなければ、取り消して要求し直す。既定 4000。 */
  retryAfterMs?: number;
  /** ブロックを 1 つ受け取るたびに、送ってきたピアの ID (libp2p) で呼ばれる。取得元の内訳を知るため。 */
  onSender?: (peerId: string) => void;
}

export interface Fetched {
  /** 実際に取得して測ったバイト数 */
  size: number;
  /** 先頭の最大 16 バイト (種類の判定用) */
  head: Uint8Array;
}

export interface IpfsNode {
  info: IpfsInfo;
  /**
   * CID の中身を IPFS から取得して、実測のサイズと先頭バイトを返す (pin はしない)。
   * ディレクトリ・上限超過・取得できない場合は ContentRejected を投げる。
   */
  fetchVerified(cid: string, limits: FetchLimits): Promise<Fetched>;
  pin(cid: string): Promise<void>;
  unpin(cid: string): Promise<void>;
  /** pin されていないブロックを消してメモリを空ける。 */
  gc(): Promise<void>;
  /** このノードがそのブロックを持っているか。 */
  has(cid: string): Promise<boolean>;
  /** バイト列を IPFS に追加して、CID を返す (URL から取得した画像・動画・音声を置くため)。 */
  addBytes(bytes: Uint8Array): Promise<string>;
  /** 中身を、指定した範囲 (offset から length バイト) だけ流す (動画のストリーミング配信)。 */
  cat(cid: string, options?: { offset?: number; length?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  stop(): Promise<void>;
}

/**
 * サーバー側の Helia ノード。役割は次の 3 つ。
 * - libp2p の WebSocket で待ち受け、ブラウザの Helia ノードの接続先 (bootstrap) になる
 * - circuit relay でブラウザ同士の接続 (WebRTC) の仲介をする
 * - 置かれた画像・ファイルを取得して pin し、アップロードした人が退室した後も配信し続ける
 */
export async function startIpfs(
  wsPort: number,
  {
    host = "0.0.0.0",
    publicPort = wsPort,
    blockstoreDir,
    resetBlockstore = true,
  }: {
    /** libp2p の WebSocket を待ち受けるアドレス。リバースプロキシの背後なら 127.0.0.1。 */
    host?: string;
    /** ブラウザから見たポート (リバースプロキシで変わる場合)。クライアントへ `welcome` で伝える。 */
    publicPort?: number;
    /**
     * ブロックを置くディレクトリ。指定すると、中身はメモリではなくディスクに置く (大きなファイルのために必須)。
     * legacy では起動時に空にする: このサーバーは、再起動するとワールドの状態 (どのオブジェクトがどの中身を指すか)
     * を失うので、前回のブロックを残しても、誰からも参照されないままディスクを埋めるだけになる。
     * crdt-v1 では `resetBlockstore: false` にして、保持した内容を再起動後も使う。
     * 指定しなければメモリ上 (テスト用)。
     */
    blockstoreDir?: string;
    /**
     * 起動時にブロックストアを削除するか (既定 true = legacy の挙動)。
     * false のときはディレクトリを残したまま開く。
     */
    resetBlockstore?: boolean;
  } = {},
): Promise<IpfsNode> {
  let blockstore: FsBlockstore | undefined;
  if (blockstoreDir) {
    if (resetBlockstore) await rm(blockstoreDir, { recursive: true, force: true });
    await mkdir(blockstoreDir, { recursive: true });
    blockstore = new FsBlockstore(blockstoreDir);
    await blockstore.open();
  }

  const helia = await withBitswap(
    withLibp2pLight(createHeliaLight(blockstore ? { blockstore } : {}), {
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
    // 直前に送ったブロックは、同じ相手から 5 秒間は再送しない (bitswap の既定)。
    // ダウンロードが途中で中断して取り直すと、その要求が無視されて止まるため、窓を 0 にする。
    // 中断のたびに相手も状態を捨てればよいが、bitswap を単体で作り直す手段がなく、
    // ノードごと作り直すとピア ID・配信中のアップロード・中継の予約まで失う。
    { doNotResendBlockWindow: 0 },
  ).start();

  const fs = unixfs(helia);

  async function fetchVerified(cidString: string, limits: FetchLimits): Promise<Fetched> {
    const cid = CID.parse(cidString);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(limits.maxTotalMs ?? 60 * 60_000)]);
    let tooLarge = false;
    let idle = false;

    // データが届かない状態が続いたら打ち切る。届くたびに時計を戻す
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        abort.abort();
      }, limits.idleTimeoutMs);
    };

    const failed = (err: unknown): ContentRejected => {
      if (tooLarge) return new ContentRejected(limits.tooLargeMessage);
      if (idle) return new ContentRejected("IPFS から取得できませんでした (一定時間データが届かず、タイムアウトしました)");
      if (signal.aborted) return new ContentRejected("IPFS から取得できませんでした (時間がかかりすぎて、タイムアウトしました)");
      console.warn("[ipfs] fetch failed:", err);
      return new ContentRejected("IPFS から取得できませんでした");
    };

    /**
     * 1 回の取得。最初のデータが `retryAfterMs` 届かなければ、取り消して `"retry"` を返す。
     * 送信側の設定 (doNotResendBlockWindow) や、要求の取りこぼしで先頭のブロックが届かないことがあるので、
     * 取り消して要求し直す (取り消すと、相手の要求の記録が消える)。このノードは窓を 0 にしているが、
     * 相手が古い設定のクライアント (再読み込みしていないタブなど) のこともあるため、保険として残す。
     */
    const attempt = async (): Promise<Fetched | "retry"> => {
      const stall = new AbortController();
      const attemptSignal = AbortSignal.any([signal, stall.signal]);
      let stalled = false;
      let stallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        stalled = true;
        stall.abort();
      }, limits.retryAfterMs ?? 4_000);
      const gotData = () => {
        clearTimeout(stallTimer);
        stallTimer = undefined;
        touch();
      };
      try {
        // 中身を取得する前に、ルートのブロックだけで種別とサイズを確かめる
        let declared: number;
        try {
          const stat = await fs.stat(cid, { signal: attemptSignal });
          gotData();
          if (stat.type === "directory") throw new ContentRejected("ディレクトリは置けません");
          if (stat.size > BigInt(limits.maxBytes)) throw new ContentRejected(limits.tooLargeMessage);
          declared = Number(stat.size);
          limits.onDeclaredSize?.(declared);
        } catch (err) {
          if (err instanceof ContentRejected) throw err;
          if (stalled && !signal.aborted) return "retry";
          throw failed(err);
        }

        // サイズは申告 (DAG のメタデータ) ではなく、実際に取得したバイト数で測る
        let size = 0;
        const head = new Uint8Array(SNIFF_BYTES);
        let headLength = 0;
        // ルートのブロックが手元にあっても、中身 (先頭のブロック) が届かないことがある。そのときも、取り消して要求し直す
        stallTimer ??= setTimeout(() => {
          stalled = true;
          stall.abort();
        }, limits.retryAfterMs ?? 4_000);
        try {
          const onSender = limits.onSender;
          const catOptions = {
            signal: attemptSignal,
            ...(limits.headOnly ? { length: SNIFF_BYTES } : {}),
            ...(onSender
              ? {
                  onProgress: (evt: { type: string; detail?: unknown }) => {
                    if (evt.type === "bitswap:block") onSender(String((evt.detail as { sender: unknown }).sender));
                  },
                }
              : {}),
          };
          for await (const chunk of fs.cat(cid, catOptions)) {
            gotData();
            if (headLength < SNIFF_BYTES) {
              const part = chunk.subarray(0, SNIFF_BYTES - headLength);
              head.set(part, headLength);
              headLength += part.length;
            }
            size += chunk.length;
            if (size > limits.maxBytes) {
              tooLarge = true;
              abort.abort();
              break;
            }
            if (!limits.headOnly) limits.onProgress?.(size, declared); // 先頭だけのときは、進捗ではない
          }
        } catch (err) {
          if (stalled && size === 0 && !signal.aborted) return "retry";
          throw failed(err);
        }
        if (tooLarge) throw new ContentRejected(limits.tooLargeMessage);
        // 先頭だけを取得したときは、実測のサイズは分からない。宣言されたサイズを返す
        return { size: limits.headOnly ? declared : size, head: head.slice(0, headLength) };
      } finally {
        clearTimeout(stallTimer);
      }
    };

    touch();
    try {
      for (;;) {
        const result = await attempt();
        if (result !== "retry") return result;
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }

  async function pin(cidString: string): Promise<void> {
    const cid = CID.parse(cidString);
    // 同じ内容が再び置かれることがある (pin 済みの CID を再度 add するとエラーになる)
    if (await helia.pins.isPinned(cid)) return;
    // pins.add はジェネレーターなので最後まで回す
    for await (const _ of helia.pins.add(cid)) {
      // 何もしない
    }
  }

  async function unpin(cidString: string): Promise<void> {
    const cid = CID.parse(cidString);
    if (!(await helia.pins.isPinned(cid))) return;
    for await (const _ of helia.pins.rm(cid)) {
      // 何もしない
    }
  }

  return {
    info: { peerId: helia.libp2p.peerId.toString(), wsPort: publicPort },
    fetchVerified,
    pin,
    unpin,
    gc: () => helia.gc(),
    has: async (cid) => helia.blockstore.has(CID.parse(cid)),
    addBytes: async (bytes) => (await fs.addBytes(bytes)).toString(),
    cat: (cidString, options = {}) => fs.cat(CID.parse(cidString), options),
    stop: async () => {
      await helia.stop();
    },
  };
}
