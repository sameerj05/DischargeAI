import { Router } from "express";
import type { AppContext } from "../context.js";
import { logRef } from "../crypto/sumId.js";

/** GET /jobs/:jobId (provider): follow the 202. Stage and run metadata; no patient text. */
export function jobsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/jobs/:jobId", async (req, res) => {
    const job = await ctx.jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ statusCode: 404, error: "job_not_found", message: "Unknown job" });
      return;
    }
    const link = await ctx.activeLinks.getBySumId(job.sumId);
    res.json({
      jobId: job.id,
      stage: job.stage,
      inputKind: job.inputKind,
      error: job.error,
      meta: job.meta,
      sumId: job.sumId,
      linkRef: logRef(job.sumId),
      linkStatus: link?.status ?? null,
      expiresAt: link?.expiresAt ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });
  return r;
}
