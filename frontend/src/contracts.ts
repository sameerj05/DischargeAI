import type { DischargePlan, Language } from "./data.js"
export type SummaryResponse = {
  sumId: string; patientID: string; status: string; "llm-summary": unknown; createdAt: string; expiresAt: string; daysLeft: number
  translatedPlan?: DischargePlan; language?: Language; translationStatus?: string; translationProblems?: string[]
}
