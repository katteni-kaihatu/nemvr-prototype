import assert from "node:assert/strict";

const WS_URL = process.env.WS_URL || "ws://127.0.0.1:8080/anything";
const HTTP_URL = (process.env.HTTP_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const clients = [];

function createClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const listeners = [];
  let closed = false;

  ws.addEventListener("message", (event) => {
    const parse = async () => {
      const text =
        typeof event.data === "string"
          ? event.data
          : typeof event.data?.text === "function"
            ? await event.data.text()
            : String(event.data);

      try {
        messages.push(JSON.parse(text));
      } catch {
        return;
      }

      for (const listener of [...listeners]) listener();
    };

    void parse();
  });

  ws.addEventListener("close", () => {
    closed = true;
    for (const listener of [...listeners]) listener();
  });

  ws.addEventListener("error", () => {
    closed = true;
    for (const listener of [...listeners]) listener();
  });

  const client = {
    ws,
    send(message) {
      ws.send(JSON.stringify(message));
    },
    async waitFor(predicate, label) {
      for (;;) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        if (closed) throw new Error(`socket closed while waiting for ${label}`);
        await new Promise((resolve) => listeners.push(resolve));
      }
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        ws.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        ws.close(1000, "smoke done");
      });
    },
  };

  clients.push(client);
  return client;
}

async function connect(url) {
  const client = createClient(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), 5_000);
    client.ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    client.ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to ${url}`));
      },
      { once: true },
    );
  });
  return client;
}

function assertPosition(actual, expected, label) {
  assert.ok(Array.isArray(actual), `${label}: position is not an array`);
  assert.equal(actual.length, 3, `${label}: position length`);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `${label}: position[${i}]`);
  }
}

async function main() {
  const primary = await connect(WS_URL);
  primary.send({ type: "join", name: "smoke" });

  const welcome = await primary.waitFor((m) => m.type === "welcome", "welcome");
  assert.equal(welcome.tickRate, 20, "welcome.tickRate");
  assert.ok(Array.isArray(welcome.objects), "welcome.objects is an array");
  assert.equal(welcome.objects.length, 5, "welcome.objects length");
  assert.ok(
    welcome.objects.every((object) => object && object.kind === "box"),
    "welcome.objects are demo boxes",
  );
  assert.equal(new Set(welcome.objects.map((object) => object.id)).size, 5, "seeded ids unique");
  assert.match(welcome.self.id, UUID_RE, "self.id is a lowercase UUID");
  assert.equal(typeof welcome.ipfs.wsPort, "number", "ipfs.wsPort is a number");
  assert.ok(!Object.hasOwn(welcome, "sync"), "welcome has no sync field");

  const selfId = welcome.self.id;
  const seededIds = new Set(welcome.objects.map((object) => object.id));

  const observer = await connect(WS_URL);
  observer.send({ type: "join", name: "smoke-observer" });
  await observer.waitFor((m) => m.type === "welcome", "observer welcome");

  primary.send({
    type: "place_box",
    position: [1, 0, 1],
    yaw: 0.25,
    size: 1,
    color: "#123456",
  });

  const added = await primary.waitFor(
    (m) =>
      m.type === "object_added" &&
      m.object &&
      !seededIds.has(m.object.id) &&
      m.object.color === "#123456",
    "object_added",
  );

  const object = added.object;
  assert.ok(!seededIds.has(object.id), "placed object id is new");
  assert.equal(object.kind, "box", "object_added kind");
  assertPosition(object.position, [1, 0, 1], "object_added");
  assert.equal(object.yaw, 0.25, "object_added yaw");
  assert.equal(object.size, 1, "object_added size");
  assert.equal(object.color, "#123456", "object_added color");

  primary.send({ type: "grab_object", id: object.id });
  const grabbed = await primary.waitFor(
    (m) =>
      m.type === "object_updated" && m.object?.id === object.id && m.object.heldBy === selfId,
    "grab object_updated",
  );
  assert.equal(grabbed.object.heldBy, selfId, "grab heldBy");

  primary.send({
    type: "move_object",
    id: object.id,
    position: [2, 0, 2],
    yaw: 0.5,
  });

  const moved = await observer.waitFor(
    (m) =>
      m.type === "object_updated" &&
      m.object?.id === object.id &&
      Array.isArray(m.object.position) &&
      Math.abs(m.object.position[0] - 2) < 1e-9 &&
      Math.abs(m.object.position[2] - 2) < 1e-9,
    "move object_updated",
  );
  assertPosition(moved.object.position, [2, 0, 2], "move");
  assert.equal(moved.object.yaw, 0.5, "move yaw");
  assert.equal(moved.object.heldBy, selfId, "move heldBy");

  primary.send({ type: "duplicate_object", id: object.id });
  const duplicate = await primary.waitFor(
    (m) =>
      m.type === "object_added" &&
      m.object &&
      m.object.id !== object.id &&
      !seededIds.has(m.object.id),
    "duplicate object_added",
  );
  assert.notEqual(duplicate.object.id, object.id, "duplicate id is new");
  assert.ok(!Object.hasOwn(duplicate.object, "heldBy"), "duplicate is not held");

  primary.send({ type: "delete_object", id: object.id });
  await primary.waitFor(
    (m) => m.type === "object_removed" && m.id === object.id,
    "object_removed",
  );

  primary.send({ type: "delete_object", id: duplicate.object.id });
  await primary.waitFor(
    (m) => m.type === "object_removed" && m.id === duplicate.object.id,
    "duplicate object_removed",
  );

  primary.send({
    type: "pose",
    pose: { position: [3, 0, 3], head: [0, 0, 0, 1] },
  });

  const snapshot = await primary.waitFor(
    (m) =>
      m.type === "snapshot" &&
      m.poses?.[selfId] &&
      Array.isArray(m.poses[selfId].position) &&
      Math.abs(m.poses[selfId].position[0] - 3) < 1e-9 &&
      Math.abs(m.poses[selfId].position[2] - 3) < 1e-9,
    "snapshot pose",
  );
  assertPosition(snapshot.poses[selfId].position, [3, 0, 3], "snapshot");
  assert.deepEqual(snapshot.poses[selfId].head, [0, 0, 0, 1], "snapshot head");

  const mediaResponse = await fetch(`${HTTP_URL}/media/deadbeef`);
  assert.equal(mediaResponse.status, 404, "/media/deadbeef status");

  // 本番の Caddy は /media と /ws 以外を SPA として返すため、この確認は
  // サーバーへ直接つなぐときだけ行う (SMOKE_CHECK_HTTP_404=0 で省略)。
  if (process.env.SMOKE_CHECK_HTTP_404 !== "0") {
    const otherResponse = await fetch(`${HTTP_URL}/not-media`);
    assert.equal(otherResponse.status, 404, "/not-media status");
  }
}

const timeout = setTimeout(() => {
  console.error("SMOKE FAIL: timed out after 15000ms");
  process.exit(1);
}, 15_000);

try {
  await main();
  clearTimeout(timeout);
  await Promise.all(clients.map((client) => client.close()));
  console.log("SMOKE OK");
  process.exit(0);
} catch (error) {
  clearTimeout(timeout);
  console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  process.exit(1);
}
