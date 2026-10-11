import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { isSumIdShaped, logRef, newSumId } from "../crypto/sumId.js";
import { AppError, badRequest, gone, notFound } from "../errors.js";
import { emailLinks, synthesizeLink } from "../pipeline/ingestJob.js";

const Body = z.object({
  sumId: z.string().trim().optional(),
  linkId: z.string().trim().optional(),
  text: z.string().optional(),
});

/**
 * POST /synthesize (provider): the diagram's lane-3 entry point, so the teammate who owns the agent
 * can re-run it after a change without a new ingest.
 *   { text }    sends the text to the DischargeAI agent in a fresh session and returns its response
 *               as it came back; nothing is stored
 *   { sumId }   sends the raw-text stored on the summary item to the agent again (session id = the
 *               sum-id), replaces llm-summary with the new response and emails the patient and the
 *               caregiver if the link had not been sent yet (`linkId` is accepted for `sumId`)
 */
export function synthesizeRouter(ctx: AppContext): Router {
  const r = Router();

  r.post("/synthesize", async (req, res) => {
    const body = Body.parse(req.body ?? {});
    const sumId = body.sumId ?? body.linkId;
    if (sumId) {
      if (!isSumIdShaped(sumId)) throw badRequest("invalid_link", "sumId must be the 43-character id returned by POST /ingest");
      const link = await ctx.activeLinks.getBySumId(sumId);
      if (!link) throw notFound("link_not_found", "No summary with that id");
      if (link.status === "purged") throw gone("link_purged", "This summary was permanently deleted after 30 days");
      if (link.status === "expired" || new Date(link.expiresAt).getTime() <= ctx.clock.now().getTime()) {
        throw gone("link_expired", "This summary expired 30 days after it was created", { expiresAt: link.expiresAt });
      }
      const job = await ctx.jobs.latestForLink(sumId);
      if (job && !["done", "needs_review", "failed"].includes(job.stage)) {
        throw new AppError(409, "job_in_progress", "The ingest job for this summary is still running; follow GET /jobs/:jobId first", { jobId: job.id, stage: job.stage });
      }
      const item = await ctx.summaries.get(sumId);
      const text = item?.["raw-text"];
      if (!item || !text) throw new AppError(409, "no_source_text", "No clinician text is stored for this summary yet (an audio ingest stores it after transcription)");

      const run = await synthesizeLink(ctx, link, text, item.inputKind);
      let emailed = !!link.emailedAt;
      if (!link.emailedAt) {
        await emailLinks(ctx, link);
        emailed = true;
      }
      await ctx.audit.append({ event: "synthesize.run", sumId, actor: "provider", at: ctx.clock.nowIso(), details: { provider: ctx.agent.name, latencyMs: run.latencyMs, emailed } });
      res.json({ stored: true, sumId, linkRef: logRef(sumId), status: "ready", emailed, "llm-summary": run.response, latencyMs: run.latencyMs, expiresAt: link.expiresAt });
      return;
    }

    const text = (body.text ?? "").trim();
    if (!text) throw badRequest("empty_input", "Provide { sumId } or { text }");
    const run = await ctx.agent.invoke(text, newSumId());
    res.json({ stored: false, "llm-summary": run.response, latencyMs: run.latencyMs });
  });

  return r;
}
