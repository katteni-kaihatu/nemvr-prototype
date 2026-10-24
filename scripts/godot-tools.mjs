import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const project = resolve(root, "apps/godot-client");

export function godotBinary() {
  for (const bin of [process.env.GODOT4_BIN, "godot4", "godot"].filter(Boolean)) {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (probe.status === 0 && /^4\./.test(probe.stdout.trim())) return bin;
  }
  throw new Error("Godot 4 not found. Enter nix develop or set GODOT4_BIN.");
}

export function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

export async function build({ release = false, windows = false, skipCargo = false } = {}) {
  const profile = release ? "release" : "debug";
  const target = windows ? "x86_64-pc-windows-gnu" : null;
  if (!skipCargo) {
    // Interrupted or concurrent Rust builds have produced stale incremental
    // objects with undefined hidden LLVM symbols. Release packaging must not
    // depend on that cache.
    const env = { ...process.env, CARGO_INCREMENTAL: "0" };
    if (windows) {
      const linker = env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER || "x86_64-w64-mingw32-gcc";
      const pthread = spawnSync(linker, ["-print-file-name=libpthread.a"], { encoding: "utf8" });
      if (pthread.status !== 0) throw new Error("Windows export requires nix develop .#windows and the Rust x86_64-pc-windows-gnu target.");
      if (!existsSync(pthread.stdout.trim())) {
        // Nix MinGW uses mcfgthread; Rust windows-gnu asks for this archive by its pthread name.
        const compiler = linker.includes("/") ? linker : spawnSync("which", [linker], { encoding: "utf8" }).stdout.trim();
        const closure = spawnSync("nix-store", ["-qR", realpathSync(compiler)], { encoding: "utf8" });
        const library = (closure.stdout || "").trim().split("\n").map((path) => resolve(path, "lib/libmcfgthread.a")).find(existsSync);
        if (!library) throw new Error("MinGW libpthread.a/libmcfgthread.a not found");
        const linkDirectory = resolve(root, "target/godot-win-link");
        await mkdir(linkDirectory, { recursive: true });
        // Nix store copies are read-only; replace a previous staging file.
        await rm(resolve(linkDirectory, "libpthread.a"), { force: true });
        await copyFile(library, resolve(linkDirectory, "libpthread.a"));
        env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS = `${env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS || ""} -L ${linkDirectory}`.trim();
      }
    }
    await run("rustup", ["run", "1.95.0", "cargo", "build", "-p", "proto-godot",
      ...(release ? ["--release"] : []), ...(target ? ["--target", target] : [])], { env });
  }
  const filename = windows ? "proto_godot.dll" : "libproto_godot.so";
  const source = resolve(process.env.CARGO_TARGET_DIR || resolve(root, "target"),
    ...(target ? [target] : []), profile, filename);
  const destination = resolve(project, "native", windows ? "windows" : "linux", profile, filename);
  if (!existsSync(source)) throw new Error(`Missing native library: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.${process.pid}.tmp`;
  await copyFile(source, staging);
  await rename(staging, destination);
  console.log(`Staged ${destination}`);
}

export async function importProject(bin = godotBinary()) {
  if (!["addons/vrm/LICENSE", "addons/Godot-MToon-Shader/LICENSE", "addons/vrm/vrm_extension.gd"]
    .every((path) => existsSync(resolve(project, path)))) {
    await run("bash", ["scripts/setup-godot-addons.sh"]);
  }
  if (!existsSync(resolve(project, "webrtc_native.gdextension"))) {
    await run("bash", ["scripts/setup-webrtc-native.sh"]);
  }
  mkdirSync(resolve(project, ".godot"), { recursive: true });
  writeFileSync(resolve(project, ".godot/extension_list.cfg"), "res://native/proto.gdextension\n");
  // The WebRTC GDExtension can abort the headless editor while unloading.
  // Runtime/export do not need the editor import pass.
  if (process.env.PROTO_FORCE_IMPORT !== "1") return;
  await run(bin, ["--headless", "--path", project, "--editor", "--import"]);
}

export function fail(error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
