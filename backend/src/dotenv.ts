import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal .env loader (no dependency): KEY=value lines, # comments, optional quotes. Values already
 * present in the environment win, so shell-sourced AWS credentials are never overridden by a file.
 */
export function loadDotEnv(file: string = join(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
