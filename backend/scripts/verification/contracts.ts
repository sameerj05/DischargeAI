/** Patient summary envelope shared by the browser API client and live verification script. */
export type SummaryResponse = {
  sumId: string
  patientID: string
  status: string
  "llm-summary": unknown
  createdAt: string
  expiresAt: string
  daysLeft: number
}
