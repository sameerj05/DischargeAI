import { Router } from "express";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { resolveSummary, sumIdFromQuery, summaryBody } from "./linkAccess.js";

/**
 * The team contract: `GET /llm-sumary?sum-id=...` (spelled exactly so) "gets llm generated summary
 * based on the summary id from the dynamodb table". Returns the agent's response as it was saved.
 * `GET /llm-summary` and `?sum_id=` are served too.
 */
export function llmSummaryRouter(ctx: AppContext): Router {
  const r = Router();
  const handler = async (req: Parameters<Parameters<Router["get"]>[1]>[0], res: Parameters<Parameters<Router["get"]>[1]>[1]) => {
    const sumId = sumIdFromQuery(req.query as Record<string, unknown>);
    if (!sumId) throw badRequest("missing_sum_id", "sum-id is required, e.g. /llm-sumary?sum-id=<id from POST /ingest>");
    res.json(await summaryBody(ctx, await resolveSummary(ctx, sumId), "llm-sumary"));
  };
  r.get("/llm-sumary", handler);
  r.get("/llm-summary", handler);
  return r;
}
