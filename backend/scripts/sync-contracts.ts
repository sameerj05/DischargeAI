/**
 * Writes contracts/ai-output.schema.json from the zod schema in src/agents/aiOutput.ts.
 *   npm run sync-contracts          # rewrite the file
 *   npm run sync-contracts -- --check   # exit 1 when the committed file is stale (CI / tests)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiOutputJsonSchema } from "../src/agents/aiOutput.js";

const file = join(import.meta.dirname, "..", "contracts", "ai-output.schema.json");
const next = JSON.stringify(aiOutputJsonSchema(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (current !== next) {
    console.error(`${file} is out of date; run: npm run sync-contracts`);
    process.exit(1);
  }
  console.log(`${file} is in sync`);
} else {
  writeFileSync(file, next);
  console.log(`wrote ${file}`);
}
