import { z } from "zod";
import {
  ChecklistItemSchema,
  ChecklistTypeSchema,
  DiagnosisSchema,
  FollowUpSchema,
  type SimplifiedSummary,
  type Warning,
} from "./types.js";

/**
 * The lane-3 contract from the team architecture diagram: one FIXED JSON object per language,
 * `{ steps, medications, followUps, warnings }` plus `language` and `readingLevel`. Person A renders
 * it, Person C produces it, the backend validates it with this schema before storing or serving it.
 *
 * It is a projection of the richer SimplifiedSummary the backend already produces (see toAiOutput):
 * the richer fields (summary, diagnoses, checklist, questionsToAsk) ride along as optional extras,
 * the four keys are always present. Safety-check results live OUTSIDE this object, in `meta`;
 * a failed check that the patient must know about becomes a clinic-tier warning inside it.
 *
 * The same shape is published as backend/contracts/ai-output.schema.json (JSON Schema 2020-12,
 * generated from this file by `npm run sync-contracts`) and backend/contracts/ai-output.ts (plain
 * TypeScript types), both served by the API under /contracts/.
 */

export const StepCategorySchema = ChecklistTypeSchema;

export const StepSchema = z.object({
  id: z.string().min(1).describe("Stable id, e.g. med-1, appt-1, vital-1; the checklist check-off endpoint uses it"),
  text: z.string().min(1).describe("One action the patient can do, in the object's language"),
  category: StepCategorySchema.describe("med | appointment | referral | vital | lab | lifestyle"),
  due: z.string().optional().describe("When, in plain words, e.g. 'every morning'"),
});

export const MedicationStatusSchema = z.enum(["new", "continue", "stop"]);

export const AiMedicationSchema = z.object({
  name: z.string().min(1).describe("Drug name exactly as written in the clinician's text, never translated"),
  dose: z.string().describe("Dose exactly as written in the source, e.g. '40 mg'; empty when the source gives none or the drug is stopped"),
  howOften: z.string().describe("How often and how, in the object's language; numbers stay verbatim; empty for stopped drugs"),
  status: MedicationStatusSchema,
  why: z.string().describe("Why the patient takes it, or why it was stopped or held, in plain words"),
  startDate: z.string().optional(),
});

export const WarningTierSchema = z.enum(["call911", "er", "clinic"]);

export const AiWarningSchema = z.object({
  tier: WarningTierSchema.describe("call911: life threatening; er: same-day urgent care; clinic: call the care team"),
  text: z.string().min(1),
});

export const AiOutputSchema = z
  .object({
    language: z.string().min(2).describe("BCP-47 code of every patient-facing string in this object"),
    readingLevel: z.enum(["grade5"]),
    steps: z.array(StepSchema),
    medications: z.array(AiMedicationSchema),
    followUps: z.array(FollowUpSchema),
    warnings: z.array(AiWarningSchema).describe("Return precautions by tier, plus any safety notice the patient must act on"),
    summary: z.string().optional().describe("3 to 5 short sentences (richer field, optional)"),
    diagnoses: z.array(DiagnosisSchema).optional(),
    checklist: z.array(ChecklistItemSchema).optional().describe("The richer checklist the steps were projected from"),
    questionsToAsk: z.array(z.string()).optional(),
  })
  .loose();

export type AiOutput = z.infer<typeof AiOutputSchema>;
export type AiMedication = z.infer<typeof AiMedicationSchema>;
export type AiWarning = z.infer<typeof AiWarningSchema>;
export type Step = z.infer<typeof StepSchema>;

export const AI_OUTPUT_KEYS = ["steps", "medications", "followUps", "warnings"] as const;

/** Codes of safety-check warnings that the patient must be told about (a clinic-tier warning is added). */
export const PATIENT_FACING_CHECK_CODES: ReadonlySet<string> = new Set(["med_not_in_source", "dose_not_in_source"]);

/** The clinic-tier notice added when the fidelity check fails. Written in English; translated with everything else. */
export const FIDELITY_NOTICE =
  "Some medicine names or doses in this summary could not be matched to your hospital record. Check your medicine list with your care team before you take anything.";

/**
 * Projects the richer summary onto the fixed per-language contract. Pure and deterministic:
 *   steps        <- checklist (type -> category)
 *   medications  <- new + continue + stop, flattened with a status
 *   followUps    <- followUps
 *   warnings     <- returnPrecautions by tier (call911 -> call911, goToER -> er, callClinic -> clinic)
 */
export function toAiOutput(summary: SimplifiedSummary): AiOutput {
  const med = (status: "new" | "continue") => (m: SimplifiedSummary["medications"]["new"][number]): AiMedication => ({
    name: m.name,
    dose: m.dose,
    howOften: m.howOften,
    status,
    why: m.why,
    ...(m.startDate ? { startDate: m.startDate } : {}),
  });
  return {
    language: summary.language,
    readingLevel: "grade5",
    steps: summary.checklist.map((c) => ({ id: c.id, text: c.text, category: c.type, ...(c.due ? { due: c.due } : {}) })),
    medications: [
      ...summary.medications.new.map(med("new")),
      ...summary.medications.continue.map(med("continue")),
      ...summary.medications.stop.map((m): AiMedication => ({ name: m.name, dose: "", howOften: "", status: "stop", why: m.why })),
    ],
    followUps: summary.followUps.map((f) => ({ who: f.who, when: f.when, why: f.why })),
    warnings: [
      ...summary.returnPrecautions.call911.map((text): AiWarning => ({ tier: "call911", text })),
      ...summary.returnPrecautions.goToER.map((text): AiWarning => ({ tier: "er", text })),
      ...summary.returnPrecautions.callClinic.map((text): AiWarning => ({ tier: "clinic", text })),
    ],
    summary: summary.summary,
    diagnoses: summary.diagnoses,
    checklist: summary.checklist,
    questionsToAsk: summary.questionsToAsk,
  };
}

/** True when a safety-check warning list contains something the patient must be told about. */
export function needsPatientNotice(warnings: Warning[]): boolean {
  return warnings.some((w) => PATIENT_FACING_CHECK_CODES.has(w.code));
}

/**
 * Adds the fidelity notice to the English summary's clinic tier (once) so it is translated along
 * with everything else and shows up as a clinic-tier `warnings[]` entry in every language.
 */
export function withPatientNotice(summary: SimplifiedSummary, warnings: Warning[]): SimplifiedSummary {
  if (!needsPatientNotice(warnings)) return summary;
  if (summary.returnPrecautions.callClinic.includes(FIDELITY_NOTICE)) return summary;
  return {
    ...summary,
    returnPrecautions: { ...summary.returnPrecautions, callClinic: [FIDELITY_NOTICE, ...summary.returnPrecautions.callClinic] },
  };
}

/** JSON Schema (draft 2020-12) for the contract. `npm run sync-contracts` writes it to contracts/. */
export function aiOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AiOutputSchema) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/sameerj05/DischargeAI/backend/contracts/ai-output.schema.json",
    title: "DischargeAI AI output (per language)",
    description:
      "The fixed per-language object the AI pipeline (lane 3) returns and the patient dashboard (lane 1) renders: steps, medications, followUps, warnings, plus language and readingLevel. Richer fields are optional extras. Generated from backend/src/agents/aiOutput.ts; do not edit by hand.",
    ...schema,
  };
}
