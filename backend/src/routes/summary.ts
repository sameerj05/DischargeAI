import { Router } from "express";
import type { AppContext } from "../context.js";
import { loadLanguageView, renderRich } from "./patientView.js";

/**
 * GET /summary?link=<linkId> (patient): the plain-language summary with expiry stated upfront.
 * Same loader as GET /p/:token, richer rendering (medications grouped new/continue/stop, tiered
 * return precautions, checklist). Pass &language= to get a translation in this shape too.
 */
export function summaryRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/summary", async (req, res) => {
    const view = await loadLanguageView(ctx, req.query.link, req.query.language);
    res.json(renderRich(view));
  });
  return r;
}
