import type { CheckItem, DischargePlan, DischargeRecord, MedGroup, MedScheduleKey } from "./data.js"
import type { SummaryResponse } from "./contracts.js"

type ObjectValue = Record<string, unknown>
const object = (v: unknown): ObjectValue => v && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : {}
const text = (v: unknown): string => typeof v === "string" ? v : ""
const list = (v: unknown): ObjectValue[] => Array.isArray(v) ? v.map(object) : []
const lines = (v: unknown) => list(v).map(i => text(i.text)).filter(Boolean)
const join = (...parts: unknown[]) => parts.map(text).filter(Boolean).join("; ")

const slots: [string, MedScheduleKey, string, number][] = [
  ["morning", "morning", "MORNING", 1], ["midday", "afternoon", "MIDDAY", 1],
  ["evening", "evening", "EVENING", 1], ["bedtime", "bedtime", "BEDTIME", 1],
  ["once_daily", "onceDaily", "ONCE A DAY", 1], ["twice_daily", "twiceDaily", "2 TIMES A DAY", 2],
  ["three_times_daily", "threeTimesDaily", "3 TIMES A DAY", 3], ["four_times_daily", "fourTimesDaily", "4 TIMES A DAY", 4],
  ["other_schedule", "otherSchedule", "OTHER SCHEDULES", 1], ["as_needed", "asNeeded", "ONLY WHEN NEEDED", 1],
]

// Map the AI-Infra plan without assigning clock times the notes did not specify.
export function adaptPlan(value: unknown): DischargePlan | undefined {
  const p = object(value)
  if (!p.schedule || !Array.isArray(p.why_in_hospital)) return undefined
  const schedule = object(p.schedule)
  const groups: MedGroup[] = slots.flatMap(([slot, key, label, doses]) => {
    const items = list(schedule[slot]).flatMap((med, index) => Array.from({ length: doses }, (_, dose) => ({
      id: `med-${slot}-${index}-${dose}`, name: text(med.medicine),
      reason: join(doses > 1 ? `Dose ${dose + 1} of ${doses}` : "", med.purpose, med.note), trackable: key !== "asNeeded",
    })))
    return items.length ? [{ key, label, items }] : []
  })
  const checks = (section: string, labelKey: string, detailKeys: string[]): CheckItem[] => list(p[section]).map((item, i) => ({
    id: `${section}-${i}`, label: text(item[labelKey]), detail: join(...detailKeys.map(k => item[k])),
  }))
  return {
    title: "Your Going-Home Plan", medications: { intro: "These are all the medicines you should take now.", groups },
    newMedicines: [...list(p.new_medicines), ...list(p.changed_medicines).map((m): ObjectValue => ({ ...m, explanation: join("CHANGED", m.explanation) }))]
      .map(m => ({ name: text(m.medicine), detail: text(m.explanation) })),
    stoppedMedicines: list(p.stopped_medicines).map(m => ({ name: text(m.medicine), detail: join(m.status, m.explanation) })),
    todos: {
      labs: checks("tests", "task", ["when", "why"]), appointments: checks("appointments", "who", ["when", "where", "why"]),
      careInstructions: checks("care_instructions", "text", []),
      ...(list(p.appointments).some(a => a.date_known !== true) ? { appointmentsNote: "If you do not have a date for a visit yet, call the office to set one up." } : {}),
    },
    generalInstructions: [...lines(p.questions_for_care_team).map(s => `Ask your care team: ${s}`), ...lines(p.call_doctor_if).map(s => `Call your doctor if: ${s}`)],
    warningSigns: { heading: "Get help right away if:", signs: lines(p.get_help_now_if), emergencyLine: "If it feels like an emergency, call 911." },
    whyHospitalized: lines(p.why_in_hospital),
  }
}

export function adaptSummary(response: SummaryResponse): { record: DischargeRecord; summary: string; status: string; flags: string[] } {
  const agent = object(response["llm-summary"])
  const plan = adaptPlan(agent.plan)
  return {
    record: { createdAt: Date.parse(response.createdAt), expiresAt: response.expiresAt, byLang: plan ? { en: plan } : {} },
    summary: typeof response["llm-summary"] === "string" ? response["llm-summary"] : text(agent.summary) || text(agent.result),
    status: text(agent.status),
    flags: Array.isArray(agent.flags) ? agent.flags.map(f => typeof f === "string" ? f : join(object(f).message, object(f).reason)).filter(Boolean) : [],
  }
}
