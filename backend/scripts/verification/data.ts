export type Language = "en" | "es" | "zh" | "ar"

// Dose-time / list grouping for medications.
export type MedScheduleKey =
  | "morning"
  | "afternoon"
  | "evening"
  | "bedtime"
  | "iv" // "IV ANTIBIOTIC"
  | "perHospitalList" // "TAKE AS YOUR HOSPITAL MEDICINE LIST SAYS"
  | "onceDaily" | "twiceDaily" | "threeTimesDaily" | "fourTimesDaily" | "otherSchedule"
  | "asNeeded" // "ONLY WHEN NEEDED"

export type MedItem = {
  id: string // opaque, stable — used for checklist state (never a drug name)
  name: string // e.g. "Furosemide 40 mg"
  reason: string // plain-language, e.g. "removes extra fluid"
  flag?: string // e.g. "NEW", "NEW, for 3 more days only", "NEW, higher dose"
  trackable?: boolean // true for checkbox dose items; "only when needed" items are not
}

export type ExplainerItem = {
  name: string // "Furosemide 40 mg"
  detail: string // full plain-language explanation incl. schedule + cautions
}

export type StoppedItem = {
  name: string
  detail: string // reason + strong warning ("Do not take both", "On HOLD until…")
}

export type CheckItem = {
  id: string // opaque, stable — used for checklist state
  label: string
  detail?: string // optional sub-explanation (indented note in the examples)
}

export type MedGroup = { key: MedScheduleKey; label: string; items: MedItem[] }

export type DischargePlan = {
  title: string
  medications: {
    intro: string
    groups: MedGroup[]
  }
  newMedicines: ExplainerItem[]
  stoppedMedicines: StoppedItem[]
  todos: {
    labs: CheckItem[] // may be empty → show "No blood tests were listed in your plan."
    appointments: CheckItem[]
    appointmentsNote?: string
    careInstructions: CheckItem[]
  }
  generalInstructions: string[]
  warningSigns: {
    heading: string
    signs: string[]
    emergencyLine: string
  }
  whyHospitalized: string[]
}

// Only languages actually returned by the backend are populated.
export type DischargePlanByLang = Partial<Record<Language, DischargePlan>>

export type DischargeRecord = { createdAt: number; expiresAt: string; byLang: DischargePlanByLang }

// Language option: `label`/`endonym` is the name in the language itself, `name`
// is the English name (both searchable), and `symbol` is a script glyph shown
// in the picker. Adding a language later is just one more array entry.
export const LANGUAGES: {
  code: Language
  label: string
  name: string
  symbol: string
}[] = [
  { code: "en", label: "English", name: "English", symbol: "A" },
  { code: "es", label: "Español", name: "Spanish", symbol: "Ñ" },
  { code: "zh", label: "中文", name: "Chinese", symbol: "中" },
  { code: "ar", label: "العربية", name: "Arabic", symbol: "ع" },
]

