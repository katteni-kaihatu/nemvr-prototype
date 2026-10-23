import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build, fail, godotBinary, importProject, project, root } from "./godot-tools.mjs";

const children = new Set();
let temporary;

function tracked(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((yes, no) => listener.listen(0, "127.0.0.1", yes).once("error", no));
  const port = listener.address().port;
  await new Promise((yes, no) => listener.close((error) => error ? no(error) : yes()));
  return port;
}

async function startServer() {
  const port = await availablePort();
  let output = "";
  let failure;
  const child = tracked("mix", ["run", "--no-halt"], {
    cwd: resolve(root, "apps/server"),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port),
      MIX_ENV: "dev", ERL_FLAGS: process.env.ERL_FLAGS || "+S 4:4" },
  });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
  child.on("error", (error) => { failure = error; });
  for (let attempt = 0; attempt < 240; attempt++) {
    if (failure || child.exitCode !== null) throw new Error(`Local server failed: ${failure || child.exitCode}\n${output}`);
    const ready = await new Promise((yes) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(200);
      const finish = (value) => { socket.destroy(); yes(value); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
    });
    if (ready) return `ws://127.0.0.1:${port}/ws`;
    await delay(250);
  }
  throw new Error(`Local server did not become ready\n${output}`);
}

function client(bin, server, name, scenario, duration) {
  const events = [];
  const waiters = new Set();
  let pending = "";
  let output = "";
  let failure;
  const child = tracked(bin, ["--headless", "--path", project, "--", "--server", server,
    "--name", name, "--scenario", scenario, "--duration", String(duration),
    "--data-dir", resolve(temporary, name)]);
  function rejectWaiters(error) {
    failure = error;
    for (const waiter of [...waiters]) waiter.reject(error);
  }
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-16000);
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line.startsWith("PROTO_EVENT ")) continue;
      let event;
      try { event = JSON.parse(line.slice("PROTO_EVENT ".length)); }
      catch (error) { rejectWaiters(new Error(`${name}: malformed event: ${error.message}`)); continue; }
      events.push(event);
      for (const waiter of [...waiters]) if (waiter.predicate(event)) waiter.resolve(event);
    }
  });
  child.on("error", rejectWaiters);
  child.on("exit", (code, signal) => rejectWaiters(new Error(`${name} exited ${code ?? signal}\n${output}`)));
  return {
    events,
    wait(predicate, description) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      if (failure) return Promise.reject(failure);
      return new Promise((yes, no) => {
        const timer = setTimeout(() => waiter.reject(new Error(`${name}: timeout waiting for ${description}\n${output}`)), 30000);
        const finish = (callback, value) => { clearTimeout(timer); waiters.delete(waiter); callback(value); };
        const waiter = { predicate, resolve: (value) => finish(yes, value), reject: (error) => finish(no, error) };
        waiters.add(waiter);
      });
    },
  };
}

function bevyClient(server, name, scenario, duration) {
  const binary = resolve(root, process.env.PROTO_CLIENT || "target/release/proto-client");
  const events = [];
  const waiters = new Set();
  let pending = "";
  let output = "";
  let failure;
  const child = tracked(binary, ["--headless", "--server", server, "--name", name,
    "--scenario", scenario, "--duration", String(duration)], { cwd: root });
  function rejectWaiters(error) {
    failure = error;
    for (const waiter of [...waiters]) waiter.reject(error);
  }
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-16000);
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { continue; }
      events.push(event);
      for (const waiter of [...waiters]) if (waiter.predicate(event)) waiter.resolve(event);
    }
  });
  child.on("error", rejectWaiters);
  child.on("exit", (code, signal) => rejectWaiters(new Error(`${name} exited ${code ?? signal}\n${output}`)));
  return {
    events,
    wait(predicate, description) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      if (failure) return Promise.reject(failure);
      return new Promise((yes, no) => {
        const timer = setTimeout(() => waiter.reject(new Error(`${name}: timeout waiting for ${description}\n${output}`)), 30000);
        const finish = (callback, value) => { clearTimeout(timer); waiters.delete(waiter); callback(value); };
        const waiter = { predicate, resolve: (value) => finish(yes, value), reject: (error) => finish(no, error) };
        waiters.add(waiter);
      });
    },
  };
}

function at(position, expected) {
  return Array.isArray(position) && position.length === 3 &&
    position.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]) < 0.01);
}

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const mixed = args.includes("--mixed");
  if (args.some((arg) => !["--no-build", "--mixed"].includes(arg))) {
    throw new Error("Usage: pnpm e2e:godot [--mixed] [--no-build]");
  }
  if (mixed && !existsSync(resolve(root, process.env.PROTO_CLIENT || "target/release/proto-client"))) {
    throw new Error("Mixed E2E needs target/release/proto-client. Run pnpm build:native first.");
  }
  const bin = godotBinary();
  await build({ skipCargo: args.includes("--no-build") });
  await importProject(bin);
  temporary = await mkdtemp(resolve(tmpdir(), "proto-godot-e2e-"));
  const server = process.env.WS_URL || await startServer();
  console.log(`Godot E2E${mixed ? " (mixed Bevy placer)" : ""}: ${server}`);
  const observer = client(bin, server, "godot-observer", "observe", 25);
  const observerWelcome = await observer.wait((event) => event.event === "welcome", "welcome");
  assert.ok(observerWelcome.selfId, "observer must have a real selfId");
  if (mixed) {
    const placer = bevyClient(server, "bevy-placer", "place", 12);
    await placer.wait((event) => event.event === "welcome", "welcome");
    const ack = await placer.wait((event) => event.event === "ack", "ack");
    assert.ok(ack.entityId, "Bevy placer must report an entity id");
    const created = await observer.wait((value) => value.event === "node_created" &&
      value.entityId === ack.entityId, `node_created for ${ack.entityId}`);
    assert.ok(at(created.position, [0, 0, -2]), "Bevy box must appear at its authoritative position");
    assert.equal(typeof created.nodePath, "string", "node_created must identify an actual node");
    assert.ok(created.nodePath.length > 0);
    console.log(JSON.stringify({ ok: true, entityId: ack.entityId, observer: observerWelcome.selfId,
      verified: ["bevy_create", "godot_node_created"] }));
  } else {
    const placer = client(bin, server, "godot-placer", "place", 12);
    await placer.wait((event) => event.event === "welcome", "welcome");
    const created = await placer.wait((event) => event.event === "scenario_created", "scenario entity id");
    assert.ok(created.entityId);
    assert.ok(at(created.position, [0, 0.5, -2]), "scenario must create at expected position");
    const mutations = [];
    for (const [kind, position] of [["node_created", [0, 0.5, -2]], ["node_updated", [2, 0.5, -2]], ["node_removed", null]]) {
      const event = await observer.wait((value) => value.event === kind && value.entityId === created.entityId &&
        (position === null || at(value.position, position)), `${kind} for ${created.entityId}`);
      assert.equal(typeof event.nodePath, "string", `${kind} must identify an actual node`);
      assert.ok(event.nodePath.length > 0);
      mutations.push(event);
    }
    assert.ok(observer.events.indexOf(mutations[0]) < observer.events.indexOf(mutations[1]));
    assert.ok(observer.events.indexOf(mutations[1]) < observer.events.indexOf(mutations[2]));
    console.log(JSON.stringify({ ok: true, entityId: created.entityId, observer: observerWelcome.selfId,
      verified: mutations.map((event) => event.event) }));
  }
} catch (error) { fail(error); }
finally {
  const active = [...children];
  await Promise.all(active.map((child) => new Promise((done) => {
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(killTimer); done(); });
    child.kill("SIGTERM");
  })));
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
