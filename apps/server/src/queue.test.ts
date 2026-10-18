import { describe, expect, it } from "vitest";
import { PlacementQueue, type QueueJob } from "./queue.js";

/** 外から完了させられるジョブ。 */
function controllable(peerId: string, log: string[], name: string) {
  let finish!: () => void;
  let fail!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const job: QueueJob = {
    peerId,
    onStart: () => log.push(`start:${name}`),
    run: async () => {
      await done;
      log.push(`end:${name}`);
    },
  };
  return { job, finish, fail };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PlacementQueue", () => {
  it("runs one job per peer at a time, in order", async () => {
    const q = new PlacementQueue(4, 10);
    const log: string[] = [];
    const a1 = controllable("alice", log, "a1");
    const a2 = controllable("alice", log, "a2");
    const a3 = controllable("alice", log, "a3");

    expect(q.enqueue(a1.job)).toBe("started");
    expect(q.enqueue(a2.job)).toBe("queued");
    expect(q.enqueue(a3.job)).toBe("queued");
    expect(log).toEqual(["start:a1"]);

    a1.finish();
    await tick();
    expect(log).toEqual(["start:a1", "end:a1", "start:a2"]);
    a2.finish();
    await tick();
    a3.finish();
    await tick();
    expect(log).toEqual(["start:a1", "end:a1", "start:a2", "end:a2", "start:a3", "end:a3"]);
    expect(q.runningCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it("lets different peers run at the same time", async () => {
    const q = new PlacementQueue(4, 10);
    const log: string[] = [];
    const a = controllable("alice", log, "a");
    const b = controllable("bob", log, "b");
    expect(q.enqueue(a.job)).toBe("started");
    expect(q.enqueue(b.job)).toBe("started");
    expect(q.runningCount).toBe(2);
    a.finish();
    b.finish();
    await tick();
  });

  it("limits the total number of concurrent jobs, and starts the waiting ones in order", async () => {
    const q = new PlacementQueue(2, 10);
    const log: string[] = [];
    const jobs = ["p1", "p2", "p3", "p4"].map((p) => controllable(p, log, p));
    expect(jobs.map((j) => q.enqueue(j.job))).toEqual(["started", "started", "queued", "queued"]);
    expect(q.runningCount).toBe(2);

    jobs[0]!.finish();
    await tick();
    expect(log).toContain("start:p3");
    expect(log).not.toContain("start:p4"); // 先に並んだ p3 が先
    jobs[1]!.finish();
    await tick();
    expect(log).toContain("start:p4");
    jobs[2]!.finish();
    jobs[3]!.finish();
    await tick();
  });

  it("does not let one waiting peer block others (a blocked peer's later job is skipped)", async () => {
    const q = new PlacementQueue(2, 10);
    const log: string[] = [];
    const a1 = controllable("alice", log, "a1");
    const a2 = controllable("alice", log, "a2"); // alice の 2 件目: a1 が終わるまで始められない
    const b1 = controllable("bob", log, "b1"); // 空きがあるので、a2 を飛ばして始まる
    q.enqueue(a1.job);
    expect(q.enqueue(a2.job)).toBe("queued");
    expect(q.enqueue(b1.job)).toBe("started");
    expect(log).toEqual(["start:a1", "start:b1"]);
    a1.finish();
    b1.finish();
    await tick();
    a2.finish();
    await tick();
  });

  it("rejects when a peer has too many waiting jobs", async () => {
    const q = new PlacementQueue(4, 2);
    const log: string[] = [];
    const jobs = [1, 2, 3, 4, 5].map((i) => controllable("alice", log, `a${i}`));
    expect(q.enqueue(jobs[0]!.job)).toBe("started"); // 実行中のものは、待ちに数えない
    expect(q.enqueue(jobs[1]!.job)).toBe("queued");
    expect(q.enqueue(jobs[2]!.job)).toBe("queued");
    expect(q.enqueue(jobs[3]!.job)).toBe("full"); // 待ちが 2 件で上限
    // 別の人は影響を受けない
    expect(q.enqueue(controllable("bob", log, "b").job)).toBe("started");
    jobs.forEach((j) => j.finish());
    await tick();
  });

  it("cancels only the waiting jobs of a peer (running ones continue)", async () => {
    const q = new PlacementQueue(4, 10);
    const log: string[] = [];
    const a1 = controllable("alice", log, "a1");
    const a2 = controllable("alice", log, "a2");
    const b1 = controllable("bob", log, "b1");
    q.enqueue(a1.job);
    q.enqueue(a2.job);
    q.enqueue(b1.job);
    expect(q.cancelPending("alice")).toBe(1); // a2 だけ
    expect(q.runningCount).toBe(2); // a1 と b1 は動いたまま
    a1.finish();
    await tick();
    expect(log).not.toContain("start:a2"); // 取り消したものは始まらない
    b1.finish();
    await tick();
  });

  it("calls onCancel for each cancelled waiting job (so its resources can be released), but not for running ones", async () => {
    const q = new PlacementQueue(4, 10);
    const log: string[] = [];
    const make = (name: string) => {
      const c = controllable("alice", log, name);
      c.job.onCancel = () => log.push(`cancel:${name}`);
      return c;
    };
    const a1 = make("a1");
    const a2 = make("a2");
    const a3 = make("a3");
    q.enqueue(a1.job);
    q.enqueue(a2.job);
    q.enqueue(a3.job);
    q.cancelPending("alice");
    expect(log).toEqual(["start:a1", "cancel:a2", "cancel:a3"]); // 実行中の a1 には呼ばれない
    a1.finish();
    await tick();
  });

  it("keeps going when a job fails", async () => {
    const q = new PlacementQueue(4, 10);
    const log: string[] = [];
    const a1 = controllable("alice", log, "a1");
    const a2 = controllable("alice", log, "a2");
    q.enqueue(a1.job);
    q.enqueue(a2.job);
    a1.fail(new Error("boom"));
    await tick();
    expect(log).toContain("start:a2"); // 失敗しても、次の順番へ進む
    expect(q.runningCount).toBe(1);
    a2.finish();
    await tick();
    expect(q.runningCount).toBe(0);
  });

  it("keeps going when onStart throws", async () => {
    const q = new PlacementQueue(4, 10);
    const log: string[] = [];
    const bad: QueueJob = {
      peerId: "alice",
      onStart: () => {
        throw new Error("onStart failed");
      },
      run: async () => {
        log.push("bad:run");
      },
    };
    const next = controllable("alice", log, "next");
    q.enqueue(bad);
    q.enqueue(next.job);
    await tick();
    expect(log).toContain("start:next");
    next.finish();
    await tick();
  });
});
