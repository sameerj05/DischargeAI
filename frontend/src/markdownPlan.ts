import type { CheckItem, DischargePlan, MedGroup, MedScheduleKey } from "./data.js"

// Recognize the AI-Infra render_markdown template. Unknown content keeps the
// complete text fallback rather than dropping a section or guessing a schedule.
export function adaptMarkdownPlan(markdown: string): DischargePlan | undefined {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean)
  if (lines.shift() !== "# Your Going-Home Plan") return undefined
  const sections = new Map<string, string[]>()
  const headings = new Set([
    "Why you were in the hospital", "Your medication list", "Things for you to do",
    "Instructions for your care", "Questions to ask your care team", "Call your doctor if", "Get help RIGHT AWAY for:",
    "MORNING", "MIDDAY", "EVENING", "BEDTIME", "ONCE A DAY", "2 TIMES A DAY", "3 TIMES A DAY", "4 TIMES A DAY",
    "OTHER SCHEDULES", "ONLY WHEN YOU NEED IT", "New medicines", "Changed medicines", "Stopped medicines", "Labs and tests", "Appointments",
  ])
  let section = ""
  for (const line of lines) {
    const heading = line.match(/^#{2,3} (.+)$/)?.[1]
    if (heading) {
      if (!headings.has(heading) || sections.has(heading)) return undefined
      section = heading; sections.set(section, [])
    } else {
      if (!section) return undefined
      sections.get(section)!.push(line)
    }
  }
  if (!sections.has("Your medication list") || !sections.has("Things for you to do")) return undefined
  const plain = (line: string) => line.replace(/\*\*([^*]+)\*\*/g, "$1")
  const bullet = (line: string) => plain(line.replace(/^- (?:\[ \] )*/, ""))
  const values = (name: string) => sections.get(name) ?? []
  const intro = values("Your medication list")
  if (intro.some(line => line !== "These are all the medicines you should take now.") || values("Things for you to do").length) return undefined
  const schedule: [string, MedScheduleKey, number][] = [
    ["MORNING", "morning", 1], ["MIDDAY", "afternoon", 1], ["EVENING", "evening", 1], ["BEDTIME", "bedtime", 1],
    ["ONCE A DAY", "onceDaily", 1], ["2 TIMES A DAY", "twiceDaily", 2], ["3 TIMES A DAY", "threeTimesDaily", 3],
    ["4 TIMES A DAY", "fourTimesDaily", 4], ["OTHER SCHEDULES", "otherSchedule", 1], ["ONLY WHEN YOU NEED IT", "asNeeded", 1],
  ]
  const groups: MedGroup[] = []
  for (const [label, key, doses] of schedule) {
    const source = values(label)
    if (source.some(line => !/^- \[ \] /.test(line))) return undefined
    const items = source.flatMap((line, index) => {
      const [name, ...detail] = bullet(line).split(" – ")
      return Array.from({ length: doses }, (_, dose) => ({
        id: `markdown-med-${key}-${index}-${dose}`, name,
        reason: [doses > 1 ? `Dose ${dose + 1} of ${doses}` : "", ...detail].filter(Boolean).join("; "), trackable: key !== "asNeeded",
      }))
    })
    if (items.length) groups.push({ key, label, items })
  }
  const bulletSections = ["Why you were in the hospital", "New medicines", "Changed medicines", "Stopped medicines", "Labs and tests",
    "Instructions for your care", "Questions to ask your care team", "Call your doctor if"]
  if (bulletSections.some(name => values(name).some(line => !line.startsWith("- ")))) return undefined
  const appointmentNote = "If you do not have a date for a visit yet, call the office to set one up."
  const emergencyLine = "If it feels like an emergency, call 911."
  if (values("Appointments").some(line => !line.startsWith("- ") && line !== appointmentNote)
    || values("Get help RIGHT AWAY for:").some(line => !line.startsWith("- ") && line !== emergencyLine)) return undefined
  const checks = (name: string): CheckItem[] => values(name).filter(line => line.startsWith("- ")).map((line, index) => ({
    id: `markdown-${name}-${index}`, label: bullet(line),
  }))
  const explain = (name: string) => values(name).map(line => {
    const [medicine, ...detail] = bullet(line).replace(/^\u274c\s*/, "").split(" – ")
    return { name: medicine, detail: [name === "Changed medicines" ? "CHANGED" : "", ...detail].filter(Boolean).join(" – ") }
  })
  return {
    title: "Your Going-Home Plan", medications: { intro: intro.join("\n"), groups },
    newMedicines: [...explain("New medicines"), ...explain("Changed medicines")], stoppedMedicines: explain("Stopped medicines"),
    todos: { labs: checks("Labs and tests"), appointments: checks("Appointments"), careInstructions: checks("Instructions for your care"),
      ...(values("Appointments").includes(appointmentNote) ? { appointmentsNote: appointmentNote } : {}) },
    generalInstructions: [...values("Questions to ask your care team").map(line => `Ask your care team: ${bullet(line)}`),
      ...values("Call your doctor if").map(line => `Call your doctor if: ${bullet(line)}`)],
    warningSigns: { heading: "Get help RIGHT AWAY for:", signs: values("Get help RIGHT AWAY for:").filter(line => line.startsWith("- ")).map(bullet),
      emergencyLine: values("Get help RIGHT AWAY for:").includes(emergencyLine) ? emergencyLine : "" },
    whyHospitalized: values("Why you were in the hospital").map(bullet),
  }
}
