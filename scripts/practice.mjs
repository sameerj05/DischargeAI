import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localNode = join(root, ".tools", "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const runtime = existsSync(localNode) ? localNode : process.execPath;
if (!process.argv[2]) { console.error('Usage: npm run test:practice -- "path/to/practice.pdf"'); process.exit(1); }
const pdf = resolve(process.argv[2]);
for (const args of [["--import", "tsx", "scripts/verify-practice.ts", pdf], ["--import", "tsx", "--test", "test/browser/local.test.ts"]]) {
  const result = spawnSync(runtime, args, { cwd: join(root, "backend"), stdio: "inherit", env: { ...process.env, PRACTICE_PDF: pdf } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
