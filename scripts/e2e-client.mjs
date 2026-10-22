#!/usr/bin/env node
// 2 つのネイティブクライアントを起動して、入室と配置の往復を確認する。
// サーバーが起動している必要がある。
//
//   pnpm e2e:client
//   WS_URL=wss://nemvr.nemnomi.dev/ws pnpm e2e:client
//
// 事前に `pnpm build:native` で target/release/proto-client を作る。
import { spawn } from "node:child_process";

const wsUrl = process.env.WS_URL ?? "ws://127.0.0.1:8080/ws";
const bin = process.env.PROTO_CLIENT ?? "target/release/proto-client";

function runClient(name, scenario, duration) {
  return new Promise((resolve, reject) => {
    const events = [];
    const child = spawn(
      bin,
      [
        "--headless",
        "--server",
        wsUrl,
        "--name",
        name,
        "--scenario",
        scenario,
        "--duration",
        String(duration),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${name}: timed out`));
    }, 30_000);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          if (event.event === "welcome") {
            finish(resolve, events);
          }
        } catch {
          // JSON 以外のログは無視する
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          reject,
          new Error(`${name}: exited with ${code}\n${stderr.trim()}`),
        );
      }
    });
  });
}

function runPlacer(name, duration) {
  return new Promise((resolve, reject) => {
    const events = [];
    const child = spawn(
      bin,
      [
        "--headless",
        "--server",
        wsUrl,
        "--name",
        name,
        "--scenario",
        "place",
        "--duration",
        String(duration),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${name}: timed out waiting for ack`));
    }, 30_000);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          if (event.event === "ack") {
            finish(resolve, events);
          }
        } catch {
          // ignore
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          reject,
          new Error(`${name}: exited with ${code}\n${stderr.trim()}`),
        );
      }
    });
  });
}

async function main() {
  if (!(await import("node:fs")).existsSync(bin)) {
    throw new Error(
      `${bin} がありません。先に 'pnpm build:native' を実行してください`,
    );
  }

  console.log(`e2e: ${wsUrl}`);
  const [, placerEvents] = await Promise.all([
    runClient("e2e-joiner", "join", 4),
    runPlacer("e2e-placer", 5),
  ]);

  const welcome = placerEvents.find((event) => event.event === "welcome");
  const ack = placerEvents.find((event) => event.event === "ack");
  if (!welcome) throw new Error("placer: welcome を受け取れませんでした");
  if (!ack) throw new Error("placer: ack を受け取れませんでした");

  console.log(
    JSON.stringify({
      ok: true,
      sessionId: welcome.sessionId,
      placer: welcome.name,
      entityId: ack.entityId,
    }),
  );
}

main().catch((error) => {
  console.error(`E2E FAIL: ${error.message}`);
  process.exit(1);
});
