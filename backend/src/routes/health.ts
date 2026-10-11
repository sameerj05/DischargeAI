import { Router } from "express";
import type { AppContext } from "../context.js";

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "dischargeai-backend",
      node: process.version,
      clock: { now: ctx.clock.nowIso(), offsetDays: ctx.clock.offsetDays, demoNow: ctx.clock.demoNow },
      linkTtlDays: ctx.linkTtlDays,
      config: {
        source: ctx.secrets.source,
        secretArn: ctx.secrets.arn ?? null,
        fromSecret: ctx.secrets.applied,
        overriddenByEnv: ctx.secrets.overriddenByEnv,
        missingKeys: ctx.secrets.missingKeys,
        reason: ctx.secrets.reason ?? null,
      },
      providers: {
        llm: ctx.agent.name,
        agentRuntimeArn: ctx.agent.runtimeArn,
        agentQualifier: ctx.config.AGENT_QUALIFIER ?? "DEFAULT",
        speech: ctx.speechToText.name,
        sqlConnection: ctx.db.describe,
        docStore: ctx.summaries.name,
        docStoreTarget: ctx.summaries.describe,
        pdf: ctx.pdf.describe(),
        audio: ctx.audio.describe(),
        receipts: ctx.receipts.name,
        email: ctx.mailer.transportName,
        emailQueue: ctx.emailQueue ? "sqs" : "none",
      },
      queue: { pending: ctx.queue.size },
    });
  });
  return r;
}
