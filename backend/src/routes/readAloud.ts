import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { resolveSummary, summaryBody } from "./linkAccess.js";
import { adaptSummary } from "../../../frontend/src/planAdapter.js";
import { speechTextFor } from "../../../frontend/src/speechText.js";
import { translatedPlanFor } from "../pipeline/agentTranslation.js";

const Body = z.object({ token: z.string(), language: z.enum(["en", "es", "zh", "ar"]), text: z.string().trim().min(1).max(5000) });
export function readAloudRouter(ctx: AppContext) {
  const r = Router();
  r.post("/read-aloud", async (req, res) => {
    if (!ctx.readAloud) throw new AppError(501, "read_aloud_unavailable", "ElevenLabs read-aloud is not configured");
    const { token, language, text } = Body.parse(req.body);
    const access = await resolveSummary(ctx, token);
    const body = await summaryBody(ctx, access, "read-aloud");
    const plan = language === "en" ? adaptSummary(body).record.byLang.en
      : translatedPlanFor(access.llmSummary, language)?.plan;
    if (!plan) throw new AppError(409, "plan_language_unavailable", "Load the plan in this language before reading it aloud");
    // Only a displayed section (or its playback chunk) may be sent to ElevenLabs.
    const strings = Object.values(speechTextFor(plan, language));
    const normalized = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
    if (!normalized(text) || !strings.some(section => normalized(section).includes(normalized(text)))) throw new AppError(400, "text_not_in_plan", "Read-aloud text must come from this patient's displayed plan");
    const audio = await ctx.readAloud.synthesize(text, language);
    // Re-check the 30-day boundary after the external call.
    await resolveSummary(ctx, token);
    res.setHeader("Content-Type", "audio/mpeg"); res.setHeader("Cache-Control", "no-store"); res.send(audio);
  });
  return r;
}
