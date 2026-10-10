import type { AiOutput } from "../agents/aiOutput.js";
import { toAiOutput } from "../agents/aiOutput.js";
import type { SimplifiedSummary, StoredTranslation } from "../agents/types.js";
import type { AppContext } from "../context.js";
import type { ChecklistItemState } from "../db/repos/checklist.js";
import { DOC } from "../docstore/types.js";
import { badRequest } from "../errors.js";
import { LANGUAGES, resolveLanguage, type Language } from "../languages.js";
import { epochSeconds } from "../pipeline/ingestJob.js";
import { resolveLink, type LinkAccess } from "./linkAccess.js";

/**
 * One loader behind every patient read: GET /summary, GET /translate, GET /p/:token. It resolves
 * the link (404 / 410 / 425 rules in linkAccess.ts), picks the language, serves the stored object
 * for that language, and runs the translate stage lazily when the language was not translated at
 * synthesis. Two renderers sit on top: the richer shape the note endpoints always returned, and the
 * diagram's fixed per-language contract for /p/:token.
 */
export interface LanguageView {
  access: LinkAccess;
  language: Language;
  /** The English summary, or the translation, as a SimplifiedSummary. */
  summary: SimplifiedSummary;
  translation?: StoredTranslation;
  /** For a translation: served from the store (true) or produced on this request (false). */
  fromCache: boolean;
  /** "en" plus every language with a stored translation. */
  readyLanguages: string[];
  checklistState: ChecklistItemState[];
}

export async function loadLanguageView(ctx: AppContext, linkParam: unknown, languageParam?: unknown): Promise<LanguageView> {
  const langRaw = typeof languageParam === "string" ? languageParam.trim() : "";
  const language = langRaw ? resolveLanguage(langRaw) : LANGUAGES[0];
  if (!language) throw badRequest("unsupported_language", `language must be one of GET /languages (got "${langRaw}")`);

  const access = await resolveLink(ctx, linkParam);
  const now = ctx.clock.nowIso();
  const checklistState = await ctx.checklist.listForLink(access.linkIdHash);
  const readyLanguages = ["en", ...(await ctx.secureDocs.listDocs(access.linkIdHash)).filter((k) => k.startsWith(DOC.translationPrefix)).map((k) => k.slice(DOC.translationPrefix.length))];
  await ctx.links.touchViewed(access.linkIdHash, now);

  if (language.code === "en") {
    await ctx.audit.append({ event: "summary.viewed", linkIdHash: access.linkIdHash, actor: "patient", at: now, details: { daysLeft: access.daysLeft } });
    return { access, language, summary: access.stored.summary, fromCache: true, readyLanguages, checklistState };
  }

  const key = access.link.encKey!;
  const doc = DOC.translation(language.code);
  const cached = await ctx.secureDocs.getJson<StoredTranslation>({ linkIdHash: access.linkIdHash, doc, key });
  if (cached) {
    await ctx.audit.append({ event: "translation.viewed", linkIdHash: access.linkIdHash, actor: "patient", at: now, details: { language: language.code, fromCache: true } });
    return { access, language, summary: cached.translation, translation: cached, fromCache: true, readyLanguages, checklistState };
  }

  // Lazy path: the language was not picked at synthesis; translate now, store, serve.
  const r = await ctx.pipeline.stages.translate.run({ summary: access.stored.summary, language });
  const stored: StoredTranslation = {
    translation: r.translation,
    backTranslation: r.backTranslation,
    warnings: r.warnings,
    provider: r.provider,
    model: r.model,
    createdAt: ctx.clock.nowIso(),
  };
  await ctx.secureDocs.putJson({ linkIdHash: access.linkIdHash, doc, key, keyVersion: access.link.keyVersion, value: stored, expiresAtEpochSeconds: epochSeconds(access.expiresAt), createdAt: stored.createdAt });
  await ctx.audit.append({ event: "translation.created", linkIdHash: access.linkIdHash, actor: "patient", at: ctx.clock.nowIso(), details: { language: language.code, provider: r.provider, model: r.model, warningCount: r.warnings.length, latencyMs: r.latencyMs, atSynthesis: false } });
  return { access, language, summary: stored.translation, translation: stored, fromCache: false, readyLanguages: [...readyLanguages, language.code], checklistState };
}

function fidelityOf(view: LanguageView): "passed" | "failed" {
  const s = view.access.stored;
  if (s.fidelity) return s.fidelity;
  return s.warnings.some((w) => w.code === "med_not_in_source" || w.code === "dose_not_in_source") ? "failed" : "passed";
}

/** The shape GET /summary has always returned (English) and GET /translate (other languages). */
export function renderRich(view: LanguageView): Record<string, unknown> {
  const { access } = view;
  if (!view.translation) {
    return {
      ...access.stored.summary,
      status: access.link.status,
      expiresAt: access.expiresAt,
      daysLeft: access.daysLeft,
      createdAt: access.link.createdAt,
      warnings: access.stored.warnings,
      needsReview: access.link.status === "needs_review",
      checklistState: view.checklistState,
      readyLanguages: view.readyLanguages,
      verification: {
        provider: access.stored.provider,
        model: access.stored.model,
        fidelityCheck: fidelityOf(view),
        readabilityGrade: access.stored.readabilityGrade,
        sourceChars: access.stored.sourceChars,
        inputKind: access.stored.inputKind,
        synthesisCount: access.stored.synthesisCount ?? 1,
      },
    };
  }
  const t = view.translation;
  return {
    ...t.translation,
    fromCache: view.fromCache,
    expiresAt: access.expiresAt,
    daysLeft: access.daysLeft,
    warnings: [...access.stored.warnings, ...t.warnings],
    needsReview: access.link.status === "needs_review",
    checklistState: view.checklistState,
    readyLanguages: view.readyLanguages,
    verification: {
      provider: t.provider,
      model: t.model,
      backTranslationCheck: t.warnings.length ? "mismatches_found" : "passed",
      translatedAt: t.createdAt,
    },
  };
}

/** The diagram's contract: the per-language object with `meta` next to it (never inside it). */
export function renderContract(view: LanguageView): AiOutput & { meta: Record<string, unknown> } {
  const { access } = view;
  const t = view.translation;
  return {
    ...toAiOutput(view.summary),
    meta: {
      status: access.link.status,
      needsReview: access.link.status === "needs_review",
      expiresAt: access.expiresAt,
      daysLeft: access.daysLeft,
      createdAt: access.link.createdAt,
      language: view.language.code,
      languageName: view.language.name,
      fromCache: view.fromCache,
      translatedAt: t?.createdAt,
      languages: { ready: view.readyLanguages, supported: LANGUAGES.map((l) => l.code) },
      checklistState: view.checklistState,
      safetyChecks: {
        fidelity: fidelityOf(view),
        readabilityGrade: access.stored.readabilityGrade,
        warnings: access.stored.warnings,
        ...(t ? { backTranslationCheck: t.warnings.length ? "mismatches_found" : "passed", translationWarnings: t.warnings } : {}),
      },
      provenance: {
        provider: t?.provider ?? access.stored.provider,
        model: t?.model ?? access.stored.model,
        inputKind: access.stored.inputKind,
        sourceChars: access.stored.sourceChars,
        stages: access.stored.stages,
        synthesisCount: access.stored.synthesisCount ?? 1,
      },
    },
  };
}
