import { buildApp } from "./app.js";
import { loadRuntimeEnv } from "./bootstrap.js";
import { createContext } from "./context.js";

const { env, secrets } = await loadRuntimeEnv();
const ctx = await createContext({ env, secrets });
const app = buildApp(ctx);
ctx.startPurgeTimer();

const server = app.listen(ctx.config.PORT, ctx.config.HOST, () => {
  ctx.log.info(
    {
      port: ctx.config.PORT,
      configSource: secrets.source,
      sql: ctx.db.describe,
      docStore: ctx.summaries.name,
      pdfStore: ctx.pdf.describe(),
      node: process.version,
      llm: ctx.agent.name,
      speech: ctx.speechToText.name,
      email: ctx.mailer.transportName,
      demoNow: ctx.clock.demoNow,
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
