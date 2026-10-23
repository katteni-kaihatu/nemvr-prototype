import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fail, root } from "./godot-tools.mjs";

const archive = resolve(root, process.argv[2] || "dist/ProtoSNS-godot-x86_64.AppImage");
const failures = [];

function run(arguments_, timeout) {
  const result = spawnSync(archive, arguments_, {
    encoding: "utf8",
    timeout,
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  return { result, output };
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

try {
  if (!existsSync(archive)) throw new Error(`Missing ${archive}. Run pnpm package:godot:linux first.`);

  const headless = run(["--headless", "--quit-after", "5"], 60000);
  check(!headless.result.error, `headless failed to start: ${headless.result.error?.message}`);
  check(headless.result.status === 0, `headless exited ${headless.result.status ?? headless.result.signal}`);
  check(headless.output.includes("Initialize godot-rust"), "headless did not initialize the GDExtension");
  check(/Godot Engine v4\.6/.test(headless.output), "headless did not start Godot 4.6");
  check(!/stack smashing detected/.test(headless.output), "headless reported stack smashing");
  check(!/Unable to create DisplayServer/.test(headless.output), "headless could not create a DisplayServer");
  check(!/\bERROR:/.test(headless.output), "headless reported an engine error");

  const graphical = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (graphical) {
    const gui = run(["--quit-after", "120"], 60000);
    check(!gui.result.error, `graphical start failed: ${gui.result.error?.message}`);
    check(gui.result.status === 0, `graphical run exited ${gui.result.status ?? gui.result.signal}`);
    check(!/stack smashing detected/.test(gui.output), "graphical run reported stack smashing");
    check(!/Unable to create DisplayServer/.test(gui.output), "graphical run could not create a DisplayServer");
    check(/(Vulkan|OpenGL).* - (Forward\+|Compatibility)/.test(gui.output), "graphical run did not initialize a renderer");
  } else {
    console.log("GUI check skipped: no DISPLAY or WAYLAND_DISPLAY");
  }

  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log("PROTO_TEST godot_linux_appimage=ok");
} catch (error) { fail(error); }
