import { build, fail, godotBinary, importProject } from "./godot-tools.mjs";

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.some((arg) => !["--release", "--no-build"].includes(arg))) {
    throw new Error("Usage: pnpm build:godot [--release] [--no-build]");
  }
  const bin = godotBinary();
  await build({ release: args.includes("--release"), skipCargo: args.includes("--no-build") });
  await importProject(bin);
} catch (error) { fail(error); }
