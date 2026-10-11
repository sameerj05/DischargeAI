import { Router } from "express";
import type { AppContext } from "../context.js";
import { resolveSummary, summaryBody } from "./linkAccess.js";

/** GET /p/:token (patient): the diagram's token link, kept as an alias of GET /llm-sumary (same body). The token is the sumId the email carries. */
export function patientLinkRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/p/:token", async (req, res) => {
    res.json(await summaryBody(ctx, await resolveSummary(ctx, req.params.token), "p"));
  });
  return r;
}
