import { build, fail, godotBinary, importProject, project, run } from "./godot-tools.mjs";

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const editor = args.includes("--editor");
  const skipCargo = args.includes("--no-build");
  const custom = args.filter((arg) => !["--editor", "--no-build"].includes(arg));
  const bin = godotBinary();
  await build({ skipCargo });
  await importProject(bin);
  await run(bin, ["--path", project, ...(editor ? ["--editor"] : []), "--", ...custom]);
} catch (error) { fail(error); }
