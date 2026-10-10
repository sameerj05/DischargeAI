import { existsSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";

export const CONTRACTS_DIR = join(import.meta.dirname, "..", "..", "contracts");

/**
 * The published lane-3 contract, served so Person A and Person C fetch the same file the backend
 * validates against: GET /contracts/ai-output.schema.json (JSON Schema 2020-12) and
 * GET /contracts/ai-output.ts (TypeScript types). No auth: the contract holds no data.
 */
export function contractsRouter(): Router {
  const r = Router();
  const files: Record<string, string> = {
    "ai-output.schema.json": "application/schema+json; charset=utf-8",
    "ai-output.ts": "text/plain; charset=utf-8",
  };
  r.get("/contracts", (_req, res) => {
    res.json({ files: Object.keys(files).map((f) => `/contracts/${f}`), source: "backend/src/agents/aiOutput.ts" });
  });
  r.get("/contracts/:file", (req, res, next) => {
    const name = req.params.file;
    const type = files[name];
    const path = join(CONTRACTS_DIR, name);
    if (!type || !existsSync(path)) {
      next();
      return;
    }
    res.setHeader("Content-Type", type);
    res.sendFile(path);
  });
  return r;
}
