import { Router } from "express";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { resolveSummary, sumIdFromQuery, summaryBody } from "./linkAccess.js";

/** GET /summary?link=<sumId> (patient): the earlier route, kept as an alias of GET /llm-sumary (same body). */
export function summaryRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/summary", async (req, res) => {
    const sumId = sumIdFromQuery(req.query as Record<string, unknown>);
    if (!sumId) throw badRequest("invalid_link", "link is required, e.g. /summary?link=<sumId>");
    res.json(await summaryBody(ctx, await resolveSummary(ctx, sumId), "summary"));
  });
  return r;
}
