import { buildApp } from "./app.js";
import { createContext } from "./context.js";
import { loadDotEnv } from "./dotenv.js";

loadDotEnv();

const ctx = await createContext();
const app = buildApp(ctx);
ctx.startPurgeTimer();

const server = app.listen(ctx.config.PORT, ctx.config.HOST, () => {
  ctx.log.info(
    {
      port: ctx.config.PORT,
      llm: ctx.simplifier.name,
      transcribe: ctx.transcriber.name,
      docStore: ctx.docStore.name,
      docTable: ctx.docStore.tableName,
      sql: ctx.db.dialect,
      sqlFallback: ctx.sql.fallback?.from ?? null,
      configSource: ctx.boot.source,
      email: ctx.mailer.transportName,
      demoMode: ctx.config.DEMO_MODE,
      purgeIntervalMs: ctx.config.PURGE_INTERVAL_MS,
    },
    `DischargeAI backend listening on http://${ctx.config.HOST}:${ctx.config.PORT} (docs at /docs)`,
  );
});

const shutdown = async (signal: string) => {
  ctx.log.info({ signal }, "shutting down");
  server.close();
  await ctx.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
