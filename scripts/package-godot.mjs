import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build, fail, godotBinary, importProject, project, root, run } from "./godot-tools.mjs";

let temporary;
try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const platform = args.shift();
  if (!["linux", "windows"].includes(platform) || args.some((arg) => arg !== "--no-build")) {
    throw new Error("Usage: node scripts/package-godot.mjs linux|windows [--no-build]");
  }
  const bin = godotBinary();
  const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
  const templateVersion = version.split(".").slice(0, 4).join(".");
  const templates = process.env.GODOT_EXPORT_TEMPLATES;
  if (!templates || !existsSync(resolve(templates, "version.txt"))) {
    throw new Error("Set GODOT_EXPORT_TEMPLATES to the matching template version directory (nix develop sets it).");
  }
  const { readFile } = await import("node:fs/promises");
  if ((await readFile(resolve(templates, "version.txt"), "utf8")).trim() !== templateVersion) {
    throw new Error(`Godot ${version} and export templates do not match: ${templates}`);
  }
  const skipCargo = args.includes("--no-build");
  await build({ release: true, windows: platform === "windows", skipCargo });
  // The editor runs on the host even when exporting the Windows bridge.
  await build({ skipCargo });
  await importProject(bin);
  temporary = await mkdtemp(resolve(tmpdir(), "proto-godot-export-"));
  const templateHome = resolve(temporary, "godot/export_templates");
  await mkdir(templateHome, { recursive: true });
  await symlink(resolve(templates), resolve(templateHome, templateVersion), "dir");
  const dist = resolve(root, "dist");
  const directoryName = `ProtoSNS-godot-${platform}-x86_64`;
  const output = resolve(temporary, directoryName);
  await mkdir(output);
  const filename = platform === "linux" ? "ProtoSNS-godot.x86_64" : "ProtoSNS-godot.exe";
  await run(bin, ["--headless", "--path", project, "--export-release",
    platform === "linux" ? "Linux" : "Windows", resolve(output, filename)],
  { env: { ...process.env, XDG_DATA_HOME: temporary } });
  await mkdir(resolve(output, "licenses"));
  for (const [source, name] of [["addons/vrm/LICENSE", "godot-vrm-MIT.txt"],
    ["addons/Godot-MToon-Shader/LICENSE", "Godot-MToon-Shader-MIT.txt"],
    ["addons/runtime_vrm/dependencies.json", "avatar-dependencies.json"]]) {
    await copyFile(resolve(project, source), resolve(output, "licenses", name));
  }
  for (const name of await readdir(resolve(project, "assets/fonts"))) {
    if (!/\.(ttf|otf|import)$/.test(name)) await copyFile(resolve(project, "assets/fonts", name), resolve(output, "licenses", name));
  }
  if (platform === "windows") {
    await writeFile(resolve(output, "Start-SteamVR.bat"),
      '@echo off\r\nstart "" "%~dp0ProtoSNS-godot.exe" --xr-mode on -- --xr --server wss://nemvr.nemnomi.dev/ws --name "%USERNAME%"\r\n');
    await writeFile(resolve(output, "Start-Desktop.bat"),
      '@echo off\r\nstart "" "%~dp0ProtoSNS-godot.exe" --xr-mode off\r\n');
    await writeFile(resolve(output, "Start-SteamVR-Debug.bat"),
      '@echo off\r\ncd /d "%~dp0"\r\nset XR_LOADER_DEBUG=all\r\n"%~dp0ProtoSNS-godot.exe" --verbose --xr-mode on -- --xr --server wss://nemvr.nemnomi.dev/ws --name "%USERNAME%" > openxr-debug.log 2>&1\r\necho Exit code %ERRORLEVEL%\r\npause\r\n');
    await writeFile(resolve(output, "README.txt"),
      ['Proto SNS Godot client','',
       'Desktop: run Start-Desktop.bat','',
       'SteamVR: install SteamVR, set it as the OpenXR runtime, then run Start-SteamVR.bat.',
       'The VR launcher adds --xr-mode on so Godot initializes OpenXR before the game script.',
       'The VR launcher connects to wss://nemvr.nemnomi.dev/ws with your Windows user name.',
       'To use another server or name, pass arguments after --, for example:',
       '  ProtoSNS-godot.exe -- --xr --server wss://example/ws --name alice','',
       'If OpenXR cannot start, the client falls back to desktop mode.',
       'If it still fails, run Start-SteamVR-Debug.bat and send openxr-debug.log.',
       'Logs are written next to the executable and to %APPDATA%\\Godot\\app_userdata\\Proto SNS\\logs.',''].join("\r\n"));
  }
  await mkdir(dist, { recursive: true });
  const archive = resolve(dist, `${directoryName}.${platform === "linux" ? "tar.gz" : "zip"}`);
  // A fresh staging directory prevents stale libraries from entering an archive.
  if (platform === "linux") await run("tar", ["-czf", archive, directoryName], { cwd: temporary });
  else {
    await rm(archive, { force: true });
    await run("zip", ["-qr", archive, directoryName], { cwd: temporary });
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  await writeFile(`${archive}.sha256`, `${hash.digest("hex")}  ${basename(archive)}\n`);
  if (platform === "linux") {
    await run("bash", ["scripts/package-godot-appimage.sh", output,
      resolve(dist, "ProtoSNS-godot-x86_64.AppImage")]);
  }
  console.log(`Godot candidate package: ${archive}`);
} catch (error) { fail(error); }
finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
