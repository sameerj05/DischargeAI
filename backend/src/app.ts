import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import type { AppContext } from "./context.js";
import { errorHandler } from "./middleware/errors.js";
import { providerAuth } from "./middleware/providerAuth.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { adminRouter } from "./routes/admin.js";
import { auditRouter } from "./routes/audit.js";
import { checklistRouter } from "./routes/checklist.js";
import { contractsRouter } from "./routes/contracts.js";
import { healthRouter } from "./routes/health.js";
import { ingestRouter } from "./routes/ingest.js";
import { jobsRouter } from "./routes/jobs.js";
import { patientsRouter } from "./routes/patients.js";
import { summaryRouter } from "./routes/summary.js";
import { translateRouter } from "./routes/translate.js";

export const OPENAPI_FILE = join(import.meta.dirname, "..", "openapi.yaml");

export function buildApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger: ctx.log,
      autoLogging: { ignore: (req) => req.url === "/health" || (req.url ?? "").startsWith("/docs") },
      serializers: {
        req: (req) => ({ method: req.method, url: String(req.url).split("?")[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-provider-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(healthRouter(ctx));
  app.use(contractsRouter());

  // OpenAPI: served from backend/openapi.yaml when present.
  if (existsSync(OPENAPI_FILE)) {
    const doc = YAML.parse(readFileSync(OPENAPI_FILE, "utf8")) as Record<string, unknown>;
    app.get("/openapi.json", (_req, res) => res.json(doc));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(doc));
  }

  // Provider endpoints: x-provider-key on these prefixes only.
  app.use(["/patients", "/ingest", "/jobs", "/audit", "/admin"], providerAuth(ctx.config.PROVIDER_API_KEY));
  app.use(patientsRouter(ctx));
  app.use(ingestRouter(ctx));
  app.use(jobsRouter(ctx));
  app.use(auditRouter(ctx));
  if (ctx.config.DEMO_MODE) app.use(adminRouter(ctx));

  // Patient endpoints: authenticated by the unguessable link id, lightly rate limited.
  app.use(["/summary", "/translate", "/languages", "/checklist"], rateLimit({ capacity: 120, refillPerSecond: 2 }));
  app.use(summaryRouter(ctx));
  app.use(translateRouter(ctx));
  app.use(checklistRouter(ctx));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler(ctx.log));
  return app;
}
