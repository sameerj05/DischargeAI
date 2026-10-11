import type { DischargePlan, Language } from "../../../frontend/src/data.js";

export interface TranslatedPlan { plan: DischargePlan; status: string; problems: string[] }

const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The agent translates inside its own run: record.byLang holds each plan and translations the verdicts. */
export function translatedPlanFor(llmSummary: unknown, lang: Language): TranslatedPlan | undefined {
  const agent = obj(llmSummary);
  const plan = obj(obj(agent.record).byLang)[lang] as DischargePlan | undefined;
  if (!plan?.medications) return undefined;
  const verdict = obj(obj(agent.translations)[lang]);
  const problems = Array.isArray(verdict.problems) ? verdict.problems.filter((p): p is string => typeof p === "string") : [];
  return { plan, status: typeof verdict.status === "string" ? verdict.status : "needs_review", problems };
}
