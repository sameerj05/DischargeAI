import { z } from "zod";

/**
 * The contract between the backend and the two teammate-owned agents. The backend validates every
 * agent result against these schemas before it is stored or served.
 */

export const MedicationSchema = z.object({
  name: z.string().min(1).describe("Drug name exactly as written in the source"),
  dose: z.string().describe("Dose exactly as written in the source, e.g. '40 mg'. Empty string if the source gives none."),
  howOften: z.string().describe("How often and how, in plain words, e.g. 'once a day by mouth'"),
  why: z.string().describe("Why the patient takes it, in plain words"),
  startDate: z.string().optional().describe("ISO date or plain phrase if the source says when to start"),
});

export const StopMedicationSchema = z.object({
  name: z.string().min(1).describe("Drug name exactly as written in the source"),
  why: z.string().describe("Why it was stopped or held, in plain words"),
});

export const ChecklistTypeSchema = z.enum(["med", "appointment", "referral", "vital", "lab", "lifestyle"]);

export const ChecklistItemSchema = z.object({
  id: z.string().min(1).describe("Stable short id, e.g. med-1, appt-1, vital-1"),
  type: ChecklistTypeSchema,
  text: z.string().min(1).describe("One action the patient can tick off"),
  due: z.string().optional().describe("When, in plain words, e.g. 'every morning', 'within 1 week'"),
});

export const DiagnosisSchema = z.object({
  plain: z.string().min(1).describe("Plain-language name"),
  clinical: z.string().min(1).describe("Clinical name from the source"),
});

export const FollowUpSchema = z.object({
  who: z.string().min(1),
  when: z.string().min(1),
  why: z.string().min(1),
});

export const SimplifiedSummarySchema = z.object({
  readingLevel: z.enum(["grade5"]).describe("Always grade5"),
  language: z.string().min(2).describe("BCP-47 code of the text, 'en' for the simplifier"),
  summary: z.string().min(1).describe("3 to 5 short sentences at a 5th-grade reading level"),
  diagnoses: z.array(DiagnosisSchema),
  medications: z.object({
    new: z.array(MedicationSchema),
    continue: z.array(MedicationSchema),
    stop: z.array(StopMedicationSchema),
  }),
  checklist: z.array(ChecklistItemSchema),
  returnPrecautions: z.object({
    call911: z.array(z.string()),
    goToER: z.array(z.string()),
    callClinic: z.array(z.string()),
  }),
  followUps: z.array(FollowUpSchema),
  questionsToAsk: z.array(z.string()),
});

export type SimplifiedSummary = z.infer<typeof SimplifiedSummarySchema>;
export type Medication = z.infer<typeof MedicationSchema>;
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const WarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  name: z.string().optional(),
  dose: z.string().optional(),
  field: z.string().optional(),
  value: z.union([z.string(), z.number()]).optional(),
});
export type Warning = z.infer<typeof WarningSchema>;

/** What the backend stores under `simplified` and serves from GET /summary (plus expiry fields). */
export const StoredSummarySchema = z.object({
  summary: SimplifiedSummarySchema,
  warnings: z.array(WarningSchema),
  provider: z.string(),
  model: z.string().optional(),
  createdAt: z.string(),
  sourceChars: z.number(),
  inputKind: z.enum(["text", "pdf", "audio"]),
  readabilityGrade: z.number().optional(),
  /** Safety-check verdict from the pipeline (src/agents/pipeline.ts). */
  fidelity: z.enum(["passed", "failed"]).optional(),
  /** Stage names that ran, in order. */
  stages: z.array(z.string()).optional(),
  /** Languages translated at synthesis time (besides en). */
  synthesizedLanguages: z.array(z.string()).optional(),
  /** How many times the record was (re)synthesized; POST /synthesize increments it. */
  synthesisCount: z.number().optional(),
});
export type StoredSummary = z.infer<typeof StoredSummarySchema>;

/** What the backend stores under `translation#<lang>` and serves from GET /translate. */
export const StoredTranslationSchema = z.object({
  translation: SimplifiedSummarySchema,
  backTranslation: SimplifiedSummarySchema.optional(),
  warnings: z.array(WarningSchema),
  provider: z.string(),
  model: z.string().optional(),
  createdAt: z.string(),
});
export type StoredTranslation = z.infer<typeof StoredTranslationSchema>;

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** JSON Schema (draft 2020-12) for the simplified summary, for tool-based structured output. */
export function simplifiedSummaryJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SimplifiedSummarySchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
