import type { Config } from "../config.js";
import { LANGUAGES, resolveLanguage, type Language } from "../languages.js";
import type { Logger } from "../logger.js";
import { checkTranslation } from "../verify/backtranslate.js";
import { checkFidelity } from "../verify/fidelity.js";
import { readabilityWarning } from "../verify/readability.js";
import { needsPatientNotice, toAiOutput, withPatientNotice, type AiOutput } from "./aiOutput.js";
import { createSimplifier, type SimplifierAgent, type SimplifyResult } from "./simplifier.js";
import { createTranscriber, type TranscriberAgent, type TranscribeResult } from "./transcriber.js";
import { createTranslator, type TranslatorAgent } from "./translator.js";
import type { LlmUsage, SimplifiedSummary, Warning } from "./types.js";

/**
 * Lane 3 of the team architecture diagram, as one module Person C owns:
 *
 *   audio --(1 transcribe)--> transcript --(2 simplify)--> draft --(3 safetyCheck)--> verified steps
 *         --(4 translate, per language)--> JSON per language
 *
 * `runPipeline({ rawText | audio, languages })` returns `{ perLanguage, meta }` where every
 * `perLanguage[lang]` is the fixed contract object (src/agents/aiOutput.ts, contracts/) and `meta`
 * carries the safety-check results, provenance and token usage. Each stage is an interface with the
 * current default implementation wired in createPipeline(); replace a stage by returning your own
 * object from there (or swap the underlying agent with LLM_PROVIDER). The backend calls this from the
 * ingest job and from POST /synthesize, then stores what comes back.
 */

export interface TranscribeStage {
  readonly name: string;
  run(input: { audio: Buffer; mimeType: string; fileName?: string }): Promise<TranscribeResult>;
}

export interface SimplifyStage {
  readonly name: string;
  run(input: { text: string; language?: string }): Promise<SimplifyResult>;
}

export interface SafetyCheckResult {
  /** Deterministic findings; codes med_not_in_source and dose_not_in_source fail the check. */
  warnings: Warning[];
  fidelity: "passed" | "failed";
  readabilityGrade?: number;
  /** The summary after the check, with the patient-facing notice added when the check failed. */
  verified: SimplifiedSummary;
}

export interface SafetyCheckStage {
  readonly name: string;
  run(input: { summary: SimplifiedSummary; sourceText: string }): Promise<SafetyCheckResult>;
}

export interface TranslateStageResult {
  translation: SimplifiedSummary;
  backTranslation?: SimplifiedSummary;
  /** Back-translation and verbatim-medication findings. */
  warnings: Warning[];
  provider: string;
  model?: string;
  usage?: LlmUsage;
  latencyMs?: number;
  fixture?: string;
}

export interface TranslateStage {
  readonly name: string;
  run(input: { summary: SimplifiedSummary; language: Language }): Promise<TranslateStageResult>;
}

export interface PipelineStages {
  transcribe: TranscribeStage;
  simplify: SimplifyStage;
  safetyCheck: SafetyCheckStage;
  translate: TranslateStage;
}

export interface PipelineInput {
  /** Clinician text (pasted, or already extracted from a PDF). Either this or `audio`. */
  rawText?: string;
  /** Dictated audio; runs the transcribe stage first. */
  audio?: { buffer: Buffer; mimeType: string; fileName?: string };
  /** BCP-47 codes or names from GET /languages. "en" is always produced; duplicates and unknowns are reported in meta. */
  languages?: string[];
  /** Patient preference, passed to the simplifier as context only. */
  preferredLanguage?: string;
  /** Progress callback for the job table. */
  onStage?: (stage: PipelineStageName, detail?: Record<string, unknown>) => void | Promise<void>;
}

export type PipelineStageName = "transcribing" | "simplifying" | "checking" | "translating";

export interface PipelineMeta {
  provider: string;
  model?: string;
  usage?: LlmUsage;
  latencyMs: number;
  fixture?: string;
  sourceChars: number;
  inputKind: "text" | "audio";
  transcribe?: { provider: string; jobName?: string; latencyMs?: number };
  languages: string[];
  unsupportedLanguages: string[];
  stages: string[];
  safetyChecks: {
    stage: string;
    fidelity: "passed" | "failed";
    readabilityGrade?: number;
    warnings: Warning[];
    patientNoticeAdded: boolean;
  };
  translations: Record<
    string,
    { provider: string; model?: string; fixture?: string; backTranslationCheck: "passed" | "mismatches_found"; warningCount: number; warnings: Warning[]; usage?: LlmUsage; latencyMs?: number }
  >;
}

export interface PipelineResult {
  /** The lane-3 contract, one object per language, "en" always present. */
  perLanguage: Record<string, AiOutput>;
  meta: PipelineMeta;
  /** The richer objects the contract was projected from (what the backend stores). */
  summaries: Record<string, SimplifiedSummary>;
  backTranslations: Record<string, SimplifiedSummary | undefined>;
  /** The clinician text the pipeline ran on (the transcript, for audio). */
  rawText: string;
}

export interface Pipeline {
  readonly stages: PipelineStages;
  run(input: PipelineInput): Promise<PipelineResult>;
}

/* ----- default stage implementations: thin wrappers over the existing agents and checks ----- */

export function agentTranscribeStage(agent: TranscriberAgent): TranscribeStage {
  return { name: `transcribe:${agent.name}`, run: (input) => agent.transcribe(input) };
}

export function agentSimplifyStage(agent: SimplifierAgent): SimplifyStage {
  return { name: `simplify:${agent.name}`, run: (input) => agent.simplify(input) };
}

/**
 * Never drop meds, doses, times: every medication name and numeric dose in the draft must appear in
 * the source (verify/fidelity.ts); the summary's reading grade is measured (verify/readability.ts).
 * A fidelity miss fails the check, flags the job needs_review and adds the clinic-tier notice.
 */
export function deterministicSafetyCheckStage(): SafetyCheckStage {
  return {
    name: "safetyCheck:deterministic",
    async run({ summary, sourceText }) {
      const warnings = checkFidelity(summary, sourceText);
      const readability = readabilityWarning(summary.summary);
      if (readability.warning) warnings.push(readability.warning);
      const fidelity = needsPatientNotice(warnings) ? "failed" : "passed";
      return { warnings, fidelity, readabilityGrade: readability.grade, verified: withPatientNotice(summary, warnings) };
    },
  };
}

export function agentTranslateStage(agent: TranslatorAgent): TranslateStage {
  return {
    name: `translate:${agent.name}`,
    async run({ summary, language }) {
      const r = await agent.translate({ summary, language: language.code, languageName: language.name });
      const translation: SimplifiedSummary = { ...r.translation, readingLevel: "grade5", language: language.code };
      const warnings = checkTranslation(summary, translation, r.backTranslation);
      return { translation, backTranslation: r.backTranslation, warnings, provider: r.provider, model: r.model, usage: r.usage, latencyMs: r.latencyMs, fixture: r.fixture };
    },
  };
}

/* ----- the composition ----- */

export function resolveLanguages(requested: string[] | undefined): { languages: Language[]; unsupported: string[] } {
  const seen = new Set<string>(["en"]);
  const languages: Language[] = [];
  const unsupported: string[] = [];
  for (const raw of requested ?? []) {
    const l = resolveLanguage(raw);
    if (!l) {
      if (raw.trim()) unsupported.push(raw);
      continue;
    }
    if (seen.has(l.code)) continue;
    seen.add(l.code);
    languages.push(l);
  }
  return { languages, unsupported };
}

export function composePipeline(stages: PipelineStages, log?: Logger): Pipeline {
  return {
    stages,
    async run(input) {
      const t0 = Date.now();
      const ran: string[] = [];
      let rawText = input.rawText ?? "";
      let transcribe: PipelineMeta["transcribe"];
      let inputKind: PipelineMeta["inputKind"] = "text";

      if (input.audio) {
        inputKind = "audio";
        await input.onStage?.("transcribing");
        const r = await stages.transcribe.run({ audio: input.audio.buffer, mimeType: input.audio.mimeType, fileName: input.audio.fileName });
        ran.push(stages.transcribe.name);
        transcribe = { provider: r.provider, jobName: r.jobName, latencyMs: r.latencyMs };
        rawText = r.text;
      }
      rawText = rawText.trim();
      if (!rawText) throw new Error("pipeline_empty_input");

      await input.onStage?.("simplifying");
      const simplified = await stages.simplify.run({ text: rawText, language: input.preferredLanguage });
      ran.push(stages.simplify.name);
      const draft: SimplifiedSummary = { ...simplified.summary, readingLevel: "grade5", language: "en" };

      await input.onStage?.("checking");
      const check = await stages.safetyCheck.run({ summary: draft, sourceText: rawText });
      ran.push(stages.safetyCheck.name);
      const en = check.verified;

      const { languages, unsupported } = resolveLanguages(input.languages);
      const summaries: Record<string, SimplifiedSummary> = { en };
      const backTranslations: Record<string, SimplifiedSummary | undefined> = {};
      const translations: PipelineMeta["translations"] = {};
      for (const language of languages) {
        await input.onStage?.("translating", { language: language.code });
        const r = await stages.translate.run({ summary: en, language });
        summaries[language.code] = r.translation;
        backTranslations[language.code] = r.backTranslation;
        translations[language.code] = {
          provider: r.provider,
          model: r.model,
          fixture: r.fixture,
          backTranslationCheck: r.warnings.length ? "mismatches_found" : "passed",
          warningCount: r.warnings.length,
          warnings: r.warnings,
          usage: r.usage,
          latencyMs: r.latencyMs,
        };
        log?.info({ language: language.code, provider: r.provider, warnings: r.warnings.length }, "pipeline translated");
      }
      if (languages.length) ran.push(stages.translate.name);

      const perLanguage: Record<string, AiOutput> = {};
      for (const [code, s] of Object.entries(summaries)) perLanguage[code] = toAiOutput(s);

      return {
        perLanguage,
        summaries,
        backTranslations,
        rawText,
        meta: {
          provider: simplified.provider,
          model: simplified.model,
          usage: simplified.usage,
          latencyMs: Date.now() - t0,
          fixture: simplified.fixture,
          sourceChars: rawText.length,
          inputKind,
          transcribe,
          languages: Object.keys(summaries),
          unsupportedLanguages: unsupported,
          stages: ran,
          safetyChecks: {
            stage: stages.safetyCheck.name,
            fidelity: check.fidelity,
            readabilityGrade: check.readabilityGrade,
            warnings: check.warnings,
            patientNoticeAdded: check.fidelity === "failed",
          },
          translations,
        },
      };
    },
  };
}

/**
 * Person C: this is the one place that picks the stage implementations. Each stage can be swapped
 * independently; the agents behind them come from LLM_PROVIDER / TRANSCRIBE_PROVIDER.
 */
export function createPipeline(opts: {
  transcriber: TranscriberAgent;
  simplifier: SimplifierAgent;
  translator: TranslatorAgent;
  log?: Logger;
  stages?: Partial<PipelineStages>;
}): Pipeline {
  return composePipeline(
    {
      transcribe: opts.stages?.transcribe ?? agentTranscribeStage(opts.transcriber),
      simplify: opts.stages?.simplify ?? agentSimplifyStage(opts.simplifier),
      safetyCheck: opts.stages?.safetyCheck ?? deterministicSafetyCheckStage(),
      translate: opts.stages?.translate ?? agentTranslateStage(opts.translator),
    },
    opts.log,
  );
}

/** Builds the agents from config and runs once. Handy for scripts and for Person C's local checks. */
export async function runPipeline(input: PipelineInput, config: Config, log: Logger): Promise<PipelineResult> {
  const [transcriber, simplifier, translator] = await Promise.all([
    createTranscriber(config, log),
    createSimplifier(config, log),
    createTranslator(config, log),
  ]);
  return createPipeline({ transcriber, simplifier, translator, log }).run(input);
}

export const SUPPORTED_LANGUAGE_CODES = LANGUAGES.map((l) => l.code);
