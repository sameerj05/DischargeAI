/**
 * DischargeAI: the per-language AI output contract (lane 3 of the team architecture diagram).
 *
 * Plain TypeScript types with no dependencies, so the patient dashboard (Person A) and the AI
 * pipeline (Person C) can copy or import this one file. The runtime validator lives in
 * backend/src/agents/aiOutput.ts (zod); the JSON Schema twin is ai-output.schema.json next to this
 * file. All three describe the same shape and the backend's test suite keeps them in sync
 * (`npm run test:contract`). Both files are also served by the API at
 * GET /contracts/ai-output.ts and GET /contracts/ai-output.schema.json.
 *
 * The four keys are always present. Everything a patient reads is in `language`; medication names
 * and doses are never translated. Safety-check results are NOT in this object: the API returns them
 * in `meta.safetyChecks` next to it, and a failed check the patient must act on also appears here as
 * a `clinic` warning.
 */

export type StepCategory = "med" | "appointment" | "referral" | "vital" | "lab" | "lifestyle";

export interface Step {
  /** Stable id (med-1, appt-1, vital-1, lab-1, life-1); POST /checklist/complete uses it. */
  id: string;
  /** One action the patient can do. */
  text: string;
  category: StepCategory;
  /** When, in plain words, e.g. "every morning". */
  due?: string;
}

export type MedicationStatus = "new" | "continue" | "stop";

export interface AiMedication {
  /** Exactly as written in the clinician's text; never translated. */
  name: string;
  /** Exactly as written in the source; empty when the source gives none or the drug is stopped. */
  dose: string;
  /** How often and how, in the object's language; numbers verbatim; empty for stopped drugs. */
  howOften: string;
  status: MedicationStatus;
  /** Why the patient takes it, or why it was stopped or held. */
  why: string;
  startDate?: string;
}

export interface FollowUp {
  who: string;
  when: string;
  why: string;
}

/** call911: life threatening. er: same-day urgent care. clinic: call the care team. */
export type WarningTier = "call911" | "er" | "clinic";

export interface AiWarning {
  tier: WarningTier;
  text: string;
}

export interface Diagnosis {
  plain: string;
  clinical: string;
}

export interface ChecklistItem {
  id: string;
  type: StepCategory;
  text: string;
  due?: string;
}

export interface AiOutput {
  /** BCP-47 code of every patient-facing string in this object (en, es, zh, ar, ...). */
  language: string;
  readingLevel: "grade5";
  steps: Step[];
  medications: AiMedication[];
  followUps: FollowUp[];
  /** Return precautions by tier, plus any safety notice the patient must act on. */
  warnings: AiWarning[];
  /** Richer, optional: 3 to 5 short sentences. */
  summary?: string;
  diagnoses?: Diagnosis[];
  /** Richer, optional: the checklist the steps were projected from. */
  checklist?: ChecklistItem[];
  questionsToAsk?: string[];
  /** Extra keys are allowed at the top level (the API adds `meta` next to the four keys). */
  [extra: string]: unknown;
}

/** The AI pipeline contract: raw clinician text in, one AiOutput per requested language out. */
export interface PipelineInput {
  rawText: string;
  /** BCP-47 codes; "en" is always produced. Default: ["en"]. */
  languages?: string[];
}

export interface SafetyCheckSummary {
  fidelity: "passed" | "failed";
  readabilityGrade?: number;
  /** Deterministic check findings (codes such as med_not_in_source, dose_not_in_source, readability_above_target). */
  warnings: { code: string; message: string; name?: string; dose?: string; field?: string; value?: string | number }[];
}

export interface PipelineMeta {
  provider: string;
  model?: string;
  sourceChars: number;
  languages: string[];
  stages: string[];
  safetyChecks: SafetyCheckSummary;
  translations: Record<string, { provider: string; model?: string; backTranslationCheck: "passed" | "mismatches_found"; warningCount: number }>;
  [extra: string]: unknown;
}

export interface PipelineResult {
  perLanguage: Record<string, AiOutput>;
  meta: PipelineMeta;
}
