import type { DischargePlan, Language } from "./data.js"
import { t } from "./i18n.js"

// Shared by the speaker buttons and backend authorization of speech content.
export function speechTextFor(plan: DischargePlan, language: Language) {
  return {
    introduction: `${plan.title}. ${t(language, "patientLede")}`,
    medsText: [t(language, "medicationsTitle") + ". " + plan.medications.intro,
      ...plan.medications.groups.flatMap(group => [group.label + ".", ...group.items.map(m => `${m.name}: ${m.reason}${m.flag ? ", " + m.flag : ""}.`)])].join(" "),
    newMedsText: plan.newMedicines.length ? [t(language, "newMedicinesTitle") + ".", ...plan.newMedicines.map(m => `${m.name}. ${m.detail}`)].join(" ") : "",
    stoppedMedsText: plan.stoppedMedicines.length ? [t(language, "stoppedMedicinesTitle") + ".", ...plan.stoppedMedicines.map(m => `${m.name}. ${m.detail}`)].join(" ") : "",
    todosText: [t(language, "todosTitle") + ".", t(language, "labsTitle") + ".",
      ...(plan.todos.labs.length ? plan.todos.labs.map(i => `${i.label}${i.detail ? ". " + i.detail : ""}.`) : [t(language, "labsEmpty")]),
      t(language, "appointmentsTitle") + ".", ...plan.todos.appointments.map(i => `${i.label}${i.detail ? ". " + i.detail : ""}.`),
      ...(plan.todos.appointmentsNote ? [plan.todos.appointmentsNote] : []), t(language, "careInstructionsTitle") + ".",
      ...plan.todos.careInstructions.map(i => `${i.label}${i.detail ? ". " + i.detail : ""}.`)].join(" "),
    generalText: plan.generalInstructions.length ? [t(language, "generalInstructionsTitle") + ".", ...plan.generalInstructions].join(" ") : "",
    warningText: [plan.warningSigns.heading, ...plan.warningSigns.signs.map(s => s + "."), plan.warningSigns.emergencyLine].join(" "),
    whyText: plan.whyHospitalized.length ? [t(language, "whyHospitalizedTitle") + ".", ...plan.whyHospitalized].join(" ") : "",
  }
}
