import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fail, root } from "./godot-tools.mjs";

const packageName = "ProtoSNS-godot-windows-x86_64";
const archive = resolve(root, "dist", `${packageName}.zip`);
const required = ["ProtoSNS-godot.exe", "ProtoSNS-godot.pck", "proto_godot.dll"];

function wineBinary() {
  for (const bin of [process.env.WINE_BIN, "wine64", "wine"].filter(Boolean)) {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (probe.status === 0 && /^wine-/.test(probe.stdout.trim())) return { bin, version: probe.stdout.trim() };
  }
  throw new Error("Wine not found. Enter nix develop .#windows or set WINE_BIN.");
}

let temporary;
try {
  if (!existsSync(archive)) throw new Error(`Missing ${archive}. Run pnpm package:godot:windows first.`);
  const wine = wineBinary();
  temporary = await mkdtemp(resolve(tmpdir(), "proto-godot-wine-"));
  const prefix = resolve(temporary, "prefix");
  const extracted = resolve(temporary, "package");
  const unzip = spawnSync("unzip", ["-q", archive, "-d", extracted], { encoding: "utf8" });
  if (unzip.error) throw new Error(`unzip failed: ${unzip.error.message}`);
  if (unzip.status !== 0) throw new Error(`unzip exited ${unzip.status}: ${unzip.stderr.trim()}`);
  const directory = resolve(extracted, packageName);
  for (const name of required) {
    if (!existsSync(resolve(directory, name))) throw new Error(`Package is missing ${name}`);
  }
  console.log(`Wine ${wine.version}: ${packageName}`);
  const run = spawnSync(wine.bin, [resolve(directory, "ProtoSNS-godot.exe"), "--headless", "--quit-after", "10"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, WINEPREFIX: prefix, WINEDEBUG: "-all" },
  });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  process.stdout.write(output);
  if (run.error) throw new Error(`Wine failed: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`Windows client exited ${run.status ?? run.signal}`);
  if (!output.includes("Initialize godot-rust")) throw new Error("GDExtension did not initialize");
  if (!/Godot Engine v4\.6/.test(output)) throw new Error("Godot runtime did not start");
  console.log("PROTO_TEST godot_windows_wine=ok");
} catch (error) { fail(error); }
finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
