import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentLedger } from "./contentLedger.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "proto-content-ledger-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("ContentLedger", () => {
  it("flush writes the current snapshot atomically", async () => {
    const dir = await tempDir();
    const path = join(dir, "content.json");
    const ledger = new ContentLedger({ path, snapshot: () => [{ cid: "a", size: 1, head: [], refs: 1 }] });

    ledger.schedule();
    await ledger.flush();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      entries: [{ cid: "a", size: 1, head: [], refs: 1 }],
    });
    expect(await readdir(dir)).toEqual(["content.json"]);
  });

  it("flush rejects (and logs) when the write fails, and leaves no temp file", async () => {
    const dir = await tempDir();
    const path = join(dir, "content.json");
    await mkdir(path); // rename の宛先をディレクトリにして、保存を失敗させる
    const logs: string[] = [];
    const ledger = new ContentLedger({ path, snapshot: () => [], log: (message) => logs.push(message) });

    await expect(ledger.flush()).rejects.toBeDefined();
    expect(logs.some((message) => message.includes("台帳"))).toBe(true);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
