import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localNode = join(root, ".tools", "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const runtime = existsSync(localNode) ? localNode : process.execPath;
const children = [
  spawn(runtime, ["--import", "tsx", "src/index.ts"], { cwd: join(root, "backend"), stdio: "inherit" }),
  spawn(runtime, ["node_modules/vite/bin/vite.js"], { cwd: join(root, "frontend"), stdio: "inherit" }),
];
let stopping = false;
const stop = code => {
  if (stopping) return;
  stopping = true;
  children.forEach(child => { if (child.exitCode === null) child.kill("SIGTERM"); });
  process.exitCode = code;
};
children.forEach(child => {
  child.on("error", err => { console.error(err.message); stop(1); });
  child.on("exit", code => { if (!stopping) stop(code ?? 1); });
});
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
