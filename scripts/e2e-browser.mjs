import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// Two headless Chromium contexts join the room, one drops an image, and both
// must load it through IPFS. This is the required browser E2E for changes that
// touch images, IPFS, the HUD, or the WebSocket protocol.
//
//   nix shell nixpkgs#chromium -c bash -lc \
//     'CHROME_PATH=$(which chromium) pnpm e2e:browser'
//
// Set SITE_URL to test another deployment. At the end the script deletes the
// image it placed (`e2e-*`).

const SITE_URL = (process.env.SITE_URL ?? "https://nemvr.nemnomi.dev").replace(/\/+$/, "");
const CHROME_PATH = process.env.CHROME_PATH;
const IMAGE_NAME = `e2e-${Date.now()}.png`;
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

if (!CHROME_PATH) throw new Error("CHROME_PATH is required (e.g. nix shell nixpkgs#chromium -c which chromium)");

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const contexts = [];
const logs = new Map();

function attach(page, label) {
  const lines = [];
  logs.set(label, lines);
  page.on("console", (msg) => {
    const text = msg.text();
    lines.push(text);
    if (text.includes("[image]") || text.includes("[ipfs]")) console.log(`${label}: ${text}`);
  });
  page.on("pageerror", (error) => console.error(`${label}: PAGEERROR ${error.message}`));
}

async function join(label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(context);
  const page = await context.newPage();
  attach(page, label);
  await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[placeholder*="表示名"]').waitFor({ timeout: 30_000 });
  await page.locator('input[placeholder*="表示名"]').fill(label);
  await page.getByRole("button", { name: "入室" }).click();
  await page.locator("canvas").waitFor({ timeout: 30_000 });
  return page;
}

async function dropImage(page) {
  await page.evaluate(
    ({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("canvas not found");
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height * 0.72,
        }),
      );
    },
    { base64: PNG, name: IMAGE_NAME },
  );
}

async function waitForLine(label, needle, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (logs.get(label)?.some((line) => line.includes(needle))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function hud(page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

async function cleanupImages() {
  const url = new URL(SITE_URL);
  const ws = new WebSocket(`${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws`);
  const queue = [];
  const waiters = [];
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  };
  const waitFor = (predicate, label, timeoutMs = 10_000) => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`timeout: ${label}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.send(JSON.stringify({ type: "space_join", name: "e2e-cleanup", templateId: "vr-sns-3d", schemaVersion: 1 }));
  await waitFor((m) => m.type === "space_welcome", "cleanup welcome");
  const requestId = crypto.randomUUID();
  ws.send(JSON.stringify({
    type: "space_query",
    requestId,
    filter: { all: [{ dim: "session.id", eq: "main" }] },
    limit: 100,
  }));
  const result = await waitFor((m) => m.type === "space_query_result" && m.requestId === requestId, "cleanup query");
  const leftovers = result.entities.filter((entity) => String(entity.dimensions["content.name"] ?? "").startsWith("e2e-"));
  for (const entity of leftovers) {
    const commandId = crypto.randomUUID();
    ws.send(JSON.stringify({
      type: "space_mutate",
      mutation: { commandId, op: "delete", entityId: entity.id },
    }));
    await waitFor((m) => m.type === "space_ack" && m.commandId === commandId, "cleanup delete");
  }
  ws.close();
  if (leftovers.length > 0) console.log("cleaned", leftovers.length, "E2E image(s)");
}

try {
  const a = await join("e2e-a");
  const b = await join("e2e-b");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  await dropImage(a);
  console.log("dropped", IMAGE_NAME, "from e2e-a");

  const aLoaded = await waitForLine("e2e-a", "[image] loaded");
  const bIpfs = await waitForLine("e2e-b", "[image] source=ipfs");
  const bLoaded = await waitForLine("e2e-b", "[image] loaded");
  const bServer = logs.get("e2e-b")?.some((line) => line.includes("[image] source=server")) ?? false;

  const aHud = await hud(a);
  const bHud = await hud(b);
  const checks = {
    aLoaded,
    bIpfs,
    bLoaded,
    noServerFallback: !bServer,
    aRtt: /RTT: \d+ ms/.test(aHud),
    bRtt: /RTT: \d+ ms/.test(bHud),
    aSource: /取得元: IPFS [1-9]/.test(aHud),
    bSource: /取得元: IPFS [1-9]/.test(bHud),
    aLog: /取得元 IPFS/.test(aHud),
    bLog: /取得元 IPFS/.test(bHud),
  };

  console.log("HUD A:", aHud);
  console.log("HUD B:", bHud);
  console.log("CHECKS", JSON.stringify(checks));
  assert.ok(checks.aLoaded, "A did not load the image");
  assert.ok(checks.bIpfs, "B did not fetch the image via IPFS");
  assert.ok(checks.bLoaded, "B did not display the image");
  assert.ok(checks.noServerFallback, "B used the server fallback");
  assert.ok(checks.aRtt && checks.bRtt, "RTT is not displayed");
  assert.ok(checks.aSource && checks.bSource, "image source counts are not displayed");
  assert.ok(checks.aLog && checks.bLog, "image source log lines are not displayed");
  console.log("BROWSER E2E OK");
} finally {
  try {
    await cleanupImages();
  } catch (error) {
    console.warn("cleanup failed:", error instanceof Error ? error.message : error);
  }
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  await browser.close();
}
