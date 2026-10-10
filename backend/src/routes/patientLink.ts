import { Router } from "express";
import type { AppContext } from "../context.js";
import { loadLanguageView, renderContract } from "./patientView.js";

/**
 * GET /p/:token (patient): the diagram's secure-link read. `token` is the link id from the email;
 * `?language=es|zh|ar|...` returns that language's object (translated and cached on first request
 * when it was not produced at synthesis). Body: the fixed per-language contract plus `meta`.
 * 400 malformed token, 404 unknown, 410 expired or purged, 425 still processing.
 */
export function patientLinkRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/p/:token", async (req, res) => {
    const view = await loadLanguageView(ctx, req.params.token, req.query.language);
    res.json(renderContract(view));
  });
  return r;
}
