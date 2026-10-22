import assert from "node:assert/strict";

// Synchronization stress test for the space v2 protocol.
//
//   CLIENTS=20 node scripts/stress-ws.mjs
//
// Each client joins, places an image at a distinct position, claims and moves
// it, then every client queries the room and must observe all placements and
// final positions. This measures join/create/move latency and protocol RTT.
// The image bytes are pinned first via /media/upload, so the test also uses the
// same content path as the browser. It is intended for the development VPS.

const SITE_URL = (process.env.SITE_URL ?? "https://nemvr.nemnomi.dev").replace(/\/+$/, "");
const URL_OBJ = new URL(SITE_URL);
const HTTP_URL = SITE_URL;
const WS_URL = `${URL_OBJ.protocol === "https:" ? "wss" : "ws"}://${URL_OBJ.host}/ws`;
const CLIENTS = Math.max(1, Number(process.env.CLIENTS ?? 20));
const MOVES = Math.max(1, Number(process.env.MOVES ?? 5));
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function now() { return performance.now(); }
function uuid() { return crypto.randomUUID(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(WS_URL);
    this.queue = [];
    this.waiters = [];
    this.errors = [];
    this.closed = false;
    this.ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.type === "space_error") this.errors.push(message);
      const index = this.waiters.findIndex((w) => w.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    };
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    return this;
  }

  send(message) { this.ws.send(JSON.stringify(message)); }

  waitFor(predicate, label, timeoutMs = 30_000) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`${this.name}: timeout waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async join() {
    const started = now();
    this.send({ type: "space_join", name: this.name, templateId: "vr-sns-3d", schemaVersion: 1 });
    const welcome = await this.waitFor((m) => m.type === "space_welcome", "space_welcome");
    return { welcome, latencyMs: now() - started };
  }

  async mutate(mutation, label = mutation.op) {
    const commandId = uuid();
    const started = now();
    this.send({ type: "space_mutate", mutation: { ...mutation, commandId } });
    const ack = await this.waitFor(
      (m) => m.type === "space_ack" && m.commandId === commandId,
      `${label} ack`,
    );
    return { ack, latencyMs: now() - started };
  }

  async query() {
    const requestId = uuid();
    this.send({
      type: "space_query",
      requestId,
      filter: { all: [{ dim: "session.id", eq: "main" }] },
      limit: 100,
    });
    return this.waitFor(
      (m) => m.type === "space_query_result" && m.requestId === requestId,
      "space_query_result",
    );
  }

  async rtt(samples = 5) {
    const values = [];
    for (let i = 0; i < samples; i++) {
      const id = i + 1;
      const started = now();
      this.send({ type: "space_ping", id });
      await this.waitFor((m) => m.type === "space_pong" && m.id === id, "space_pong");
      values.push(now() - started);
      await sleep(50);
    }
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }
}

async function uploadImage() {
  const bytes = Buffer.from(PNG, "base64");
  const response = await fetch(`${HTTP_URL}/media/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (response.status !== 200) {
    throw new Error(`image upload failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  assert.equal(typeof body.cid, "string", "upload did not return a CID");
  return body.cid;
}

async function waitUntil(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timeout: ${label}`);
}

const cid = await uploadImage();
console.log(`CID ${cid}; joining ${CLIENTS} clients`);

const clients = [];
const created = [];
const joinLatencies = [];
const createLatencies = [];
const moveLatencies = [];

try {
  for (let i = 0; i < CLIENTS; i++) {
    const client = await new Client(`stress-${i}`).open();
    clients.push(client);
    const joined = await client.join();
    joinLatencies.push(joined.latencyMs);
  }
  console.log(`joined ${clients.length} clients`);

  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    const angle = (i / clients.length) * Math.PI * 2;
    const entityId = uuid();
    const position = [Math.cos(angle) * (4 + (i % 5)), 1, Math.sin(angle) * (4 + (i % 5))];
    const result = await client.mutate({
      op: "create",
      entityId,
      dimensions: {
        "entity.kind": "image",
        "space.position": position,
        "space.yaw": angle,
        "content.cid": cid,
        "content.width": 1,
        "content.height": 1,
        "content.name": `stress-${i}.png`,
      },
    }, "create image");
    created.push({ id: entityId, client, position });
    createLatencies.push(result.latencyMs);
  }
  console.log(`created ${created.length} images`);

  await waitUntil("all clients see all images", async () => {
    for (const client of clients) {
      const result = await client.query();
      const images = result.entities.filter((e) => e.dimensions["entity.kind"] === "image" && String(e.dimensions["content.name"] ?? "").startsWith("stress-"));
      if (images.length < clients.length) return false;
    }
    return true;
  }, 30_000);
  console.log("all clients observed all placements");

  for (const item of created) {
    await item.client.mutate({ op: "claim", entityId: item.id }, "claim");
    const position = [item.position[0] + 1, item.position[1], item.position[2] - 1];
    for (let m = 0; m < MOVES; m++) {
      const result = await item.client.mutate({
        op: "patch",
        entityId: item.id,
        set: {
          "space.position": [position[0], position[1] + m * 0.05, position[2]],
          "space.yaw": m * 0.1,
        },
      }, "move image");
      moveLatencies.push(result.latencyMs);
    }
    await item.client.mutate({ op: "release", entityId: item.id }, "release");
  }
  console.log(`moved ${created.length} images x ${MOVES}`);

  await waitUntil("all clients see final positions", async () => {
    for (const client of clients) {
      const result = await client.query();
      const images = new Map(
        result.entities
          .filter((e) => e.dimensions["entity.kind"] === "image" && String(e.dimensions["content.name"] ?? "").startsWith("stress-"))
          .map((e) => [e.id, e]),
      );
      if (images.size < clients.length) return false;
      for (const item of created) {
        const entity = images.get(item.id);
        if (!entity) return false;
        const position = entity.dimensions["space.position"];
        const expectedX = item.position[0] + 1;
        const expectedZ = item.position[2] - 1;
        if (Math.abs(position[0] - expectedX) > 0.001 || Math.abs(position[2] - expectedZ) > 0.001) return false;
      }
    }
    return true;
  }, 30_000);
  console.log("all clients converged on final positions");

  const rtts = [];
  for (const client of clients) rtts.push(await client.rtt());
  const avg = (xs) => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const max = (xs) => xs.length === 0 ? 0 : Math.max(...xs);
  console.log("RESULTS", JSON.stringify({
    clients: clients.length,
    images: created.length,
    joins: { avgMs: Math.round(avg(joinLatencies)), maxMs: Math.round(max(joinLatencies)) },
    creates: { avgMs: Math.round(avg(createLatencies)), maxMs: Math.round(max(createLatencies)) },
    moves: { count: moveLatencies.length, avgMs: Math.round(avg(moveLatencies)), maxMs: Math.round(max(moveLatencies)) },
    rtt: { avgMs: Math.round(avg(rtts)), maxMs: Math.round(max(rtts)) },
    errors: clients.flatMap((c) => c.errors).length,
  }));
  for (const client of clients) {
    if (client.errors.length > 0) console.warn(client.name, client.errors.slice(0, 2));
  }
} finally {
  try {
    for (const item of created) {
      await item.client.mutate({ op: "delete", entityId: item.id }, "cleanup delete");
    }
  } catch (error) {
    console.warn("cleanup failed:", error instanceof Error ? error.message : error);
  }
  for (const client of clients) client.close();
}
