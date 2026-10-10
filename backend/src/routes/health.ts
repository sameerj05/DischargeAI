import { Router } from "express";
import type { AppContext } from "../context.js";

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "dischargeai-backend",
      clock: { now: ctx.clock.nowIso(), offsetDays: ctx.clock.offsetDays },
      linkTtlDays: ctx.linkTtlDays,
      demoMode: ctx.config.DEMO_MODE,
      config: {
        source: ctx.boot.source,
        secretLoaded: ctx.boot.loaded,
        secretArn: ctx.boot.secretArn,
        appliedFromSecret: ctx.boot.applied,
        keptFromEnv: ctx.boot.kept,
        reason: ctx.boot.reason,
      },
      sql: {
        dialect: ctx.db.dialect,
        requested: ctx.sql.requested,
        target: ctx.sql.target,
        fallback: ctx.sql.fallback ?? null,
      },
      providers: {
        llm: ctx.simplifier.name,
        llmModel: ctx.config.LLM_PROVIDER === "bedrock" ? ctx.config.BEDROCK_MODEL_ID : ctx.config.LLM_PROVIDER === "anthropic" ? ctx.config.ANTHROPIC_MODEL : "fixtures+rules",
        transcribe: ctx.transcriber.name,
        docStore: ctx.docStore.name,
        docTable: ctx.docStore.tableName,
        docHashKey: ctx.docStore.hashKey,
        audioStore: ctx.audioStore.name,
        email: ctx.mailer.transportName,
        emailQueue: ctx.emailQueue ? "sqs" : "none",
        sql: ctx.db.dialect,
      },
      queue: { pending: ctx.queue.size },
    });
  });
  return r;
}
