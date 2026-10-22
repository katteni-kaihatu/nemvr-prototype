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
  primary.send({
    type: "space_join",
    name: "smoke",
    templateId: "vr-sns-3d",
    schemaVersion: 1,
  });

  const welcome = await primary.waitFor((m) => m.type === "space_welcome", "space_welcome");
  assert.equal(welcome.tickRate, 20, "welcome.tickRate");
  assert.equal(welcome.templateId, "vr-sns-3d", "welcome.templateId");
  assert.equal(welcome.schemaVersion, 1, "welcome.schemaVersion");
  assert.ok(welcome.scope && welcome.scope.read && welcome.scope.write, "welcome.scope");
  assert.ok(welcome.dimensions && welcome.dimensions["space.position"], "welcome.dimensions");
  assert.equal(typeof welcome.version, "number", "welcome.version");
  assert.equal(welcome.seq, 0, "welcome.seq");
  assert.equal(typeof welcome.at, "number", "welcome.at");
  assert.match(welcome.self.peerId, UUID_RE, "self.peerId is a lowercase UUID");
  assert.equal(welcome.self.entityId, welcome.self.peerId, "self.entityId");
  assert.equal(typeof welcome.ipfs.wsPort, "number", "ipfs.wsPort is a number");

  const seededBoxes = welcome.entities.filter(
    (entity) => entity.dimensions["entity.kind"] === "box",
  );
  assert.equal(seededBoxes.length, 5, "welcome has five demo boxes");
  assert.equal(new Set(seededBoxes.map((entity) => entity.id)).size, 5, "seeded ids unique");

  const selfId = welcome.self.peerId;
  const seededIds = new Set(seededBoxes.map((entity) => entity.id));

  const observer = await connect(WS_URL);
  observer.send({
    type: "space_join",
    name: "smoke-observer",
    templateId: "vr-sns-3d",
    schemaVersion: 1,
  });
  await observer.waitFor((m) => m.type === "space_welcome", "observer space_welcome");

  const avatarCid = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
  const avatarCommandId = crypto.randomUUID();
  primary.send({ type: "space_set_avatar", commandId: avatarCommandId, cid: avatarCid });

  await primary.waitFor(
    (m) => m.type === "space_ack" && m.commandId === avatarCommandId,
    "avatar space_ack",
  );

  await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some(
        (change) =>
          change.op === "upsert" &&
          change.entity?.id === selfId &&
          change.entity.dimensions["peer.avatarCid"] === avatarCid,
      ),
    "avatar delta",
  );

  primary.send({ type: "space_set_avatar", commandId: crypto.randomUUID(), cid: null });

  await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some(
        (change) =>
          change.op === "upsert" &&
          change.entity?.id === selfId &&
          !Object.hasOwn(change.entity.dimensions, "peer.avatarCid"),
      ),
    "avatar clear delta",
  );

  const imageCid = process.env.SMOKE_IMAGE_CID;
  if (imageCid) {
    const imageId = crypto.randomUUID();
    const imageCommandId = crypto.randomUUID();

    primary.send({
      type: "space_mutate",
      mutation: {
        commandId: imageCommandId,
        op: "create",
        entityId: imageId,
        dimensions: {
          "entity.kind": "image",
          "space.position": [4, 1, 4],
          "space.yaw": 0,
          "content.cid": imageCid,
          "content.width": 1,
          "content.height": 1,
        },
      },
    });

    await primary.waitFor(
      (m) => m.type === "space_ack" && m.commandId === imageCommandId,
      "image space_ack (is SMOKE_IMAGE_CID available to Kubo?)",
    );

    const imageDelta = await observer.waitFor(
      (m) =>
        m.type === "space_delta" &&
        m.changes.some(
          (change) =>
            change.op === "upsert" &&
            change.entity?.id === imageId &&
            change.entity.dimensions["entity.kind"] === "image" &&
            change.entity.dimensions["content.cid"] === imageCid,
        ),
      "image delta",
    );

    const imageEntity = imageDelta.changes.find((change) => change.entity?.id === imageId).entity;
    assert.equal(imageEntity.dimensions["content.stored"], false, "image is placed before pinning");
    assert.equal(imageEntity.dimensions["content.owner"], selfId, "image is served by its owner");

    primary.send({
      type: "space_mutate",
      mutation: { commandId: crypto.randomUUID(), op: "delete", entityId: imageId },
    });

    await observer.waitFor(
      (m) =>
        m.type === "space_delta" &&
        m.changes.some((change) => change.op === "remove" && change.id === imageId),
      "image delete delta",
    );
  }

  const boxId = crypto.randomUUID();
  const createId = crypto.randomUUID();
  primary.send({
    type: "space_mutate",
    mutation: {
      commandId: createId,
      op: "create",
      entityId: boxId,
      dimensions: {
        "entity.kind": "box",
        "space.position": [1, 0, 1],
        "space.yaw": 0.25,
        "box.size": 1,
        "box.color": "#123456",
      },
    },
  });

  await primary.waitFor(
    (m) => m.type === "space_ack" && m.commandId === createId,
    "create space_ack",
  );

  const added = await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some(
        (change) =>
          change.op === "upsert" &&
          change.entity?.id === boxId &&
          change.entity.dimensions["entity.kind"] === "box",
      ),
    "observer create delta",
  );

  const createdEntity = added.changes.find((change) => change.entity?.id === boxId).entity;
  assert.ok(!seededIds.has(createdEntity.id), "placed entity id is new");
  assertPosition(createdEntity.dimensions["space.position"], [1, 0, 1], "create");
  assert.equal(createdEntity.dimensions["space.yaw"], 0.25, "create yaw");
  assert.equal(createdEntity.dimensions["box.color"], "#123456", "create color");

  primary.send({
    type: "space_mutate",
    mutation: { commandId: crypto.randomUUID(), op: "claim", entityId: boxId },
  });

  await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some(
        (change) =>
          change.op === "upsert" &&
          change.entity?.id === boxId &&
          change.entity.dimensions["interaction.heldBy"] === selfId,
      ),
    "claim delta",
  );

  primary.send({
    type: "space_mutate",
    mutation: {
      commandId: crypto.randomUUID(),
      op: "patch",
      entityId: boxId,
      set: { "space.position": [2, 0, 2], "space.yaw": 0.5 },
    },
  });

  const moved = await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some(
        (change) =>
          change.op === "upsert" &&
          change.entity?.id === boxId &&
          Math.abs(change.entity.dimensions["space.position"][0] - 2) < 1e-9 &&
          Math.abs(change.entity.dimensions["space.position"][2] - 2) < 1e-9,
      ),
    "move delta",
  );

  const movedEntity = moved.changes.find((change) => change.entity?.id === boxId).entity;
  assertPosition(movedEntity.dimensions["space.position"], [2, 0, 2], "move");
  assert.equal(movedEntity.dimensions["space.yaw"], 0.5, "move yaw");
  assert.equal(movedEntity.dimensions["interaction.heldBy"], selfId, "move heldBy");

  const duplicateId = crypto.randomUUID();
  primary.send({
    type: "space_mutate",
    mutation: {
      commandId: crypto.randomUUID(),
      op: "duplicate",
      entityId: boxId,
      newEntityId: duplicateId,
    },
  });

  const duplicate = await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some(
        (change) => change.op === "upsert" && change.entity?.id === duplicateId,
      ),
    "duplicate delta",
  );

  const duplicateEntity = duplicate.changes.find((change) => change.entity?.id === duplicateId).entity;
  assert.ok(!Object.hasOwn(duplicateEntity.dimensions, "interaction.heldBy"), "duplicate is not held");

  primary.send({
    type: "space_mutate",
    mutation: { commandId: crypto.randomUUID(), op: "delete", entityId: boxId },
  });

  await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some((change) => change.op === "remove" && change.id === boxId),
    "delete delta",
  );

  primary.send({
    type: "space_mutate",
    mutation: { commandId: crypto.randomUUID(), op: "delete", entityId: duplicateId },
  });

  await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some((change) => change.op === "remove" && change.id === duplicateId),
    "duplicate delete delta",
  );

  primary.send({
    type: "space_mutate",
    mutation: {
      commandId: crypto.randomUUID(),
      op: "patch",
      entityId: selfId,
      set: {
        "space.position": [3, 0, 3],
        "space.head": [0, 0, 0, 1],
      },
    },
  });

  const pose = await observer.waitFor(
    (m) =>
      m.type === "space_delta" &&
      m.changes.some(
        (change) =>
          change.op === "upsert" &&
          change.entity?.id === selfId &&
          Array.isArray(change.entity.dimensions["space.position"]) &&
          Math.abs(change.entity.dimensions["space.position"][0] - 3) < 1e-9 &&
          Math.abs(change.entity.dimensions["space.position"][2] - 3) < 1e-9,
      ),
    "pose delta",
  );

  const poseEntity = pose.changes.find((change) => change.entity?.id === selfId).entity;
  assertPosition(poseEntity.dimensions["space.position"], [3, 0, 3], "pose");
  assert.deepEqual(poseEntity.dimensions["space.head"], [0, 0, 0, 1], "pose head");

  const legacy = await connect(WS_URL);
  legacy.send({ type: "join", name: "legacy" });
  const mismatch = await legacy.waitFor(
    (m) => m.type === "space_error" && m.code === "protocol_mismatch",
    "legacy protocol mismatch",
  );
  assert.equal(mismatch.code, "protocol_mismatch", "legacy join is rejected");

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
