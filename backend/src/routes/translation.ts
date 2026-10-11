import { Router, type Request, type Response } from "express";
import type { AppContext } from "../context.js";
import { AppError, badRequest } from "../errors.js";
import { resolveSummary, summaryBody, sumIdFromQuery } from "./linkAccess.js";
import { translatedPlanFor } from "../pipeline/agentTranslation.js";
import type { Language } from "../../../frontend/src/data.js";

/**
 * The team contract's `GET /translation?lang=&sum_id=` and its earlier spelling `GET /translate`.
 * The AgentCore agent translates during ingest; this returns its stored plan for the language.
 */
export function translationRouter(ctx: AppContext): Router {
  const r = Router();
  const translate = async (req: Request, res: Response) => {
    const lang = String(req.query.lang);
    if (!["en", "es", "zh", "ar"].includes(lang)) throw badRequest("unsupported_language", "Choose en, es, zh or ar");
    const access = await resolveSummary(ctx, sumIdFromQuery(req.query));
    const body = await summaryBody(ctx, access, "translation");
    if (lang === "en") { res.json(body); return; }
    const result = translatedPlanFor(access.llmSummary, lang as Language);
    if (!result) throw new AppError(404, "translation_unavailable", "This plan has no translation for that language");
    res.json({ ...body, language: lang, translatedPlan: result.plan, translationStatus: result.status, translationProblems: result.problems });
  };
  r.get("/translation", translate);
  r.get("/translate", translate);
  return r;
}
