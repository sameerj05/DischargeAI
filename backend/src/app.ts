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
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { ingestRouter } from "./routes/ingest.js";
import { jobsRouter } from "./routes/jobs.js";
import { llmSummaryRouter } from "./routes/llmSummary.js";
import { patientLinkRouter } from "./routes/patientLink.js";
import { patientsRouter } from "./routes/patients.js";
import { summaryRouter } from "./routes/summary.js";
import { synthesizeRouter } from "./routes/synthesize.js";
import { translationRouter } from "./routes/translation.js";
import { readAloudRouter } from "./routes/readAloud.js";

export const OPENAPI_FILE = join(import.meta.dirname, "..", "openapi.yaml");

/** Paths the team contract names, plus the earlier routes kept as aliases. */
export const PROVIDER_PATHS = ["/patients", "/ingest", "/jobs", "/synthesize"];
export const PATIENT_PATHS = ["/llm-sumary", "/llm-summary", "/translation", "/summary", "/translate", "/p", "/read-aloud"];

function buildApi(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  // POST /ingest carries a base64 PDF in JSON, so its body limit follows MAX_UPLOAD_BYTES (base64 grows bytes by 4/3).
  app.use("/ingest", express.json({ limit: Math.ceil(ctx.config.MAX_UPLOAD_BYTES * 1.4) + 64 * 1024 }));
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger: ctx.log,
      autoLogging: { ignore: (req) => req.url === "/health" || (req.url ?? "").startsWith("/docs") },
      serializers: {
        req: (req) => ({ method: req.method, url: String(req.url).split("?")[0].replace(/^\/p\/[^/]+/, "/p/:token") }),
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
  app.use("/auth", rateLimit({ capacity: 20, refillPerSecond: 0.2 }));
  app.use(authRouter(ctx));

  // OpenAPI: served from backend/openapi.yaml when present.
  if (existsSync(OPENAPI_FILE)) {
    const doc = YAML.parse(readFileSync(OPENAPI_FILE, "utf8")) as Record<string, unknown>;
    app.get("/openapi.json", (_req, res) => res.json(doc));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(doc));
  }

  // Provider endpoints (light auth): x-provider-key on these prefixes only.
  app.use(PROVIDER_PATHS, providerAuth(ctx.config.PROVIDER_API_KEY));
  app.use(patientsRouter(ctx));
  app.use(ingestRouter(ctx));
  app.use(jobsRouter(ctx));
  app.use(synthesizeRouter(ctx));

  // Patient endpoints: authenticated by the unguessable sum-id, lightly rate limited.
  app.use(PATIENT_PATHS, rateLimit({ capacity: 120, refillPerSecond: 2 }));
  app.use(llmSummaryRouter(ctx));
  app.use(translationRouter(ctx));
  app.use("/read-aloud", rateLimit({ capacity: 20, refillPerSecond: 0.2 }));
  app.use(readAloudRouter(ctx));
  app.use(summaryRouter(ctx));
  app.use(patientLinkRouter(ctx));

  app.use((_req, res) => res.status(404).json({ statusCode: 404, error: "not_found", message: "No such route" }));
  app.use(errorHandler(ctx.log));
  return app;
}

/** One origin for the built UI and API; legacy API paths remain available. */
export function buildApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  const api = buildApi(ctx);
  app.use("/api", api);
  const frontend = join(import.meta.dirname, "..", "..", "frontend", "dist");
  if (existsSync(join(frontend, "index.html"))) {
    app.use(express.static(frontend));
    app.get(["/s/:token", "/p/:token"], (req, res, next) => {
      if (req.path.startsWith("/p/") && !req.get("Accept")?.includes("text/html")) { next(); return; }
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(join(frontend, "index.html"));
    });
  }
  app.use(api);
  return app;
}
