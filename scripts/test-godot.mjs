import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build, fail, godotBinary, importProject, project, run } from "./godot-tools.mjs";

let temporary;
try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.some((arg) => !["--mirror", "--no-build"].includes(arg))) throw new Error("Unknown test:godot argument");
  const bin = godotBinary();
  await build({ skipCargo: args.includes("--no-build") });
  await importProject(bin);
  temporary = await mkdtemp(resolve(tmpdir(), "proto-godot-tests-"));
  const tests = args.includes("--mirror") ? ["mirror_render_test.gd"]
    : (await readdir(resolve(project, "tests"))).filter((name) =>
      name === "native_bridge.gd" || name === "presentation_test.gd" || name === "xr_rig_test.gd" ||
      (/^avatar.*\.gd$/.test(name) && name !== "avatar_pack.gd")).sort();
  if (!tests.length) throw new Error("No Godot tests found");
  for (const test of tests) {
    const renderers = args.includes("--mirror")
      ? [[], ["--rendering-method", "gl_compatibility"]]
      : [["--headless"]];
    for (const renderer of renderers) {
      console.log(`Godot test: ${test}${renderer.length ? ` (${renderer.at(-1)})` : ""}`);
      await run(bin, [...renderer,
        "--path", project, "--script", `res://tests/${test}`, "--", "--data-dir", temporary],
      { timeout: 120000, env: { ...process.env, XDG_CONFIG_HOME: temporary, XDG_CACHE_HOME: temporary } });
    }
  }
} catch (error) { fail(error); }
finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
