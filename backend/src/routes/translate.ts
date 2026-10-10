import { Router } from "express";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { LANGUAGES } from "../languages.js";
import { loadLanguageView, renderRich } from "./patientView.js";

/**
 * GET /translate?link=<linkId>&language=<name or code> (patient): the translation, from the store
 * when it was produced at synthesis or on an earlier request, else translated now (translate stage,
 * back-translation check) and stored. Same loader as GET /p/:token?language=. GET /languages lists
 * the options.
 */
export function translateRouter(ctx: AppContext): Router {
  const r = Router();

  r.get("/languages", (_req, res) => {
    res.json({ languages: LANGUAGES, synthesisTargets: ["es", "zh", "ar"] });
  });

  r.get("/translate", async (req, res) => {
    const langParam = typeof req.query.language === "string" ? req.query.language : "";
    if (!langParam.trim()) throw badRequest("unsupported_language", "language is required (name or code from GET /languages)");
    const view = await loadLanguageView(ctx, req.query.link, langParam);
    res.json(renderRich(view));
  });

  return r;
}
