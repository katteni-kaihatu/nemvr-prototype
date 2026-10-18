/**
 * 画像・ファイルの取り込み (IPFS からの取得・検証・pin) の順番待ち。
 *
 * - **同じ人の分は、1 件ずつ順番に** 行う。同じ接続から複数の転送を同時に要求すると、bitswap は要求を先着順に処理するので、
 *   後ろの転送は前の転送が終わるまでデータが届かず、(回線が遅いほど) アイドルタイムアウトで失敗してしまう。
 *   並列にしても、同じ接続では速くならない。
 * - **全体の同時数にも上限** を設ける (ディスクの書き込みとメモリを、取り込み 1 件ごとに使うので)。
 * - 別の人の分は、互いに待たせない (ある人の分が順番待ちでも、別の人の分は、空きがあれば始まる)。
 */

export interface QueueJob {
  peerId: string;
  /** 取り込みの本体。完了 (成功・失敗) したら、次の順番へ進む。 */
  run: () => Promise<void>;
  /** 順番が来て、始まる直前に呼ばれる。 */
  onStart?: () => void;
  /** 始まる前に取り消された (cancelPending) ときに呼ばれる。順番待ちの間に用意したものの後片付けに使う。 */
  onCancel?: () => void;
}

export type EnqueueResult =
  /** すぐに始めた */
  | "started"
  /** 順番待ちに入った */
  | "queued"
  /** その人の順番待ちが多すぎて、受け付けなかった */
  | "full";

export class PlacementQueue {
  private pending: QueueJob[] = [];
  private readonly runningPeers = new Set<string>();
  private running = 0;

  constructor(
    /** 全体で同時に取り込む件数の上限 */
    private readonly maxConcurrent: number,
    /** 1 人あたりの順番待ち (まだ始まっていないもの) の上限 */
    private readonly maxPendingPerPeer: number,
  ) {}

  get runningCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  enqueue(job: QueueJob): EnqueueResult {
    const waiting = this.pending.filter((j) => j.peerId === job.peerId).length;
    if (waiting >= this.maxPendingPerPeer) return "full";
    this.pending.push(job);
    this.pump();
    return this.pending.includes(job) ? "queued" : "started";
  }

  /** まだ始まっていない分を取り消す (その人が退室したとき)。取り消した件数を返す。 */
  cancelPending(peerId: string): number {
    const cancelled = this.pending.filter((job) => job.peerId === peerId);
    this.pending = this.pending.filter((job) => job.peerId !== peerId);
    for (const job of cancelled) job.onCancel?.();
    return cancelled.length;
  }

  private pump(): void {
    // 先に並んだものから、始められるものを始める。ある人の分が順番待ちでも、後ろの別の人の分は飛ばして始める
    for (let i = 0; i < this.pending.length && this.running < this.maxConcurrent; ) {
      const job = this.pending[i]!;
      if (this.runningPeers.has(job.peerId)) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      this.start(job);
    }
  }

  private start(job: QueueJob): void {
    this.running++;
    this.runningPeers.add(job.peerId);
    const finish = () => {
      this.running--;
      this.runningPeers.delete(job.peerId);
      this.pump();
    };
    try {
      job.onStart?.();
      void job.run().then(finish, finish); // 失敗しても、次の順番を止めない
    } catch {
      finish();
    }
  }
}
