import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const frontend = join(root, "frontend");
const localNode = join(root, ".tools", "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const runtime = existsSync(localNode) ? localNode : process.execPath;
for (const args of [
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.app.json"],
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.node.json"],
  ["node_modules/vite/bin/vite.js", "build"],
]) {
  const result = spawnSync(runtime, args, { cwd: frontend, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
