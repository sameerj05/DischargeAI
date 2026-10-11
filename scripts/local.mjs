import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localNode = join(root, ".tools", "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const runtime = existsSync(localNode) ? localNode : process.execPath;
const args = process.argv.includes("--dictation-live-test")
  ? ["--import", "tsx", "--test", "test/browser/dictation-live.test.ts"]
  : process.argv.includes("--features-test")
  ? ["--import", "tsx", "--test", "test/browser/features-live.test.ts"]
  : process.argv.includes("--live-test")
  ? ["--import", "tsx", "--test", "test/browser/live.test.ts"]
  : process.argv.includes("--browser-test")
  ? ["--import", "tsx", "--test", "test/browser/local.test.ts"]
  : ["--import", "tsx", process.argv.includes("--live-ai") ? "scripts/local-agentcore-server.ts" : "scripts/local-server.ts"];
const child = spawn(runtime, args, { cwd: join(root, "backend"), stdio: "inherit" });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
