// Discharge "Going-Home Plan" content for the patient / caregiver views.
//
// TODO: replace with real backend call — GET /p/:token returns a
// DischargePlan object keyed by language. The shapes below mirror the
// agreed backend schema so a real per-language JSON response drops in
// unchanged. Only opaque, stable ids are assigned to trackable items so
// checklist state never carries drug names, diagnoses, or any clinical text.

// Language union kept as `Language` (the patient language toggle depends on
// this name + the LANGUAGES export). The spec refers to it as `Lang`.
export type Language = "en" | "es" | "zh" | "ar"

// Dose-time / list grouping for medications.
export type MedScheduleKey =
  | "morning"
  | "afternoon"
  | "evening"
  | "bedtime"
  | "iv" // "IV ANTIBIOTIC"
  | "perHospitalList" // "TAKE AS YOUR HOSPITAL MEDICINE LIST SAYS"
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

// Content is language-keyed so the patient language toggle swaps the whole
// plan. Every supported language is fully populated for every patient — there
// is no English fallback or placeholder (that was the half-translated bug).
export type DischargePlanByLang = Record<Language, DischargePlan>

// A stored per-patient record: when it was created (for the deletion
// countdown) plus the per-language plan bundle.
//
// TODO: use the real expiresAt from GET /p/:token (the backend sets
// expiresAt = createdAt + 30 days via DynamoDB TTL + S3 lifecycle).
export type DischargeRecord = { createdAt: number; byLang: DischargePlanByLang }

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

// Standard group labels per language. Only groups that have items are rendered.
const GROUP_LABELS: Record<Language, Record<MedScheduleKey, string>> = {
  en: {
    morning: "MORNING",
    afternoon: "AFTERNOON",
    evening: "EVENING",
    bedtime: "BEDTIME",
    iv: "IV ANTIBIOTIC",
    perHospitalList: "TAKE AS YOUR HOSPITAL MEDICINE LIST SAYS",
    asNeeded: "ONLY WHEN NEEDED",
  },
  es: {
    morning: "MAÑANA",
    afternoon: "TARDE",
    evening: "NOCHE",
    bedtime: "AL ACOSTARSE",
    iv: "ANTIBIÓTICO IV",
    perHospitalList: "TÓMELOS SEGÚN SU LISTA DE MEDICAMENTOS DEL HOSPITAL",
    asNeeded: "SOLO CUANDO SEA NECESARIO",
  },
  zh: {
    morning: "早晨",
    afternoon: "下午",
    evening: "晚上",
    bedtime: "睡前",
    iv: "静脉注射抗生素",
    perHospitalList: "按照您的医院用药清单服用",
    asNeeded: "仅在需要时",
  },
  ar: {
    morning: "الصباح",
    afternoon: "بعد الظهر",
    evening: "المساء",
    bedtime: "قبل النوم",
    iv: "مضاد حيوي وريدي",
    perHospitalList: "تناولها حسب قائمة أدوية المستشفى الخاصة بك",
    asNeeded: "فقط عند الحاجة",
  },
}

// Build a med group in English (the authored source of truth). Translation of
// group labels happens in translatePlan via GROUP_LABELS.
function group(key: MedScheduleKey, items: MedItem[]): MedGroup {
  return { key, label: GROUP_LABELS.en[key], items }
}

const MED_INTRO = "These are all the medicines you should take now."

// A parallel translation table for one plan. It mirrors the English plan's
// shape, but values are the translated STRINGS only — no ids, no `trackable`,
// no group `key`s. translatePlan() zips this with the English plan so opaque
// ids and flags stay byte-identical across languages.
type PlanText = {
  title: string
  medicationsIntro: string
  // group items in the SAME order as the English plan, flattened per group
  medGroups: { items: { name: string; reason: string; flag?: string }[] }[]
  newMedicines: { name: string; detail: string }[]
  stoppedMedicines: { name: string; detail: string }[]
  labs: { label: string; detail?: string }[]
  appointments: { label: string; detail?: string }[]
  appointmentsNote?: string
  careInstructions: { label: string; detail?: string }[]
  generalInstructions: string[]
  warningHeading: string
  warningSigns: string[]
  emergencyLine: string
  whyHospitalized: string[]
}

// Zip the English plan (ids, keys, trackable flags) with a per-language text
// table to produce a complete translated DischargePlan. Opaque ids and group
// keys come ONLY from `en`, so checklist state survives a language switch.
function translatePlan(
  lang: Language,
  en: DischargePlan,
  text: PlanText,
): DischargePlan {
  return {
    title: text.title,
    medications: {
      intro: text.medicationsIntro,
      groups: en.medications.groups.map((grp, gi) => ({
        key: grp.key,
        label: GROUP_LABELS[lang][grp.key],
        items: grp.items.map((item, ii) => {
          const tr = text.medGroups[gi].items[ii]
          return {
            id: item.id,
            name: tr.name,
            reason: tr.reason,
            ...(tr.flag !== undefined ? { flag: tr.flag } : {}),
            ...(item.trackable !== undefined
              ? { trackable: item.trackable }
              : {}),
          }
        }),
      })),
    },
    newMedicines: text.newMedicines,
    stoppedMedicines: text.stoppedMedicines,
    todos: {
      labs: en.todos.labs.map((item, i) => ({
        id: item.id,
        label: text.labs[i].label,
        ...(text.labs[i].detail !== undefined
          ? { detail: text.labs[i].detail }
          : {}),
      })),
      appointments: en.todos.appointments.map((item, i) => ({
        id: item.id,
        label: text.appointments[i].label,
        ...(text.appointments[i].detail !== undefined
          ? { detail: text.appointments[i].detail }
          : {}),
      })),
      ...(text.appointmentsNote !== undefined
        ? { appointmentsNote: text.appointmentsNote }
        : {}),
      careInstructions: en.todos.careInstructions.map((item, i) => ({
        id: item.id,
        label: text.careInstructions[i].label,
        ...(text.careInstructions[i].detail !== undefined
          ? { detail: text.careInstructions[i].detail }
          : {}),
      })),
    },
    generalInstructions: text.generalInstructions,
    warningSigns: {
      heading: text.warningHeading,
      signs: text.warningSigns,
      emergencyLine: text.emergencyLine,
    },
    whyHospitalized: text.whyHospitalized,
  }
}

// ── Example 1 — HFrEF / Pneumonia / AKI ──
const example1En: DischargePlan = {
  title: "Your Care Plan",
  medications: {
    intro: MED_INTRO,
    groups: [
      group("morning", [
        {
          id: "med-ex1-furosemide-am",
          name: "Furosemide 40 mg",
          reason: "removes extra fluid",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex1-losartan-am",
          name: "Losartan 25 mg",
          reason: "for your heart and blood pressure",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex1-empagliflozin-am",
          name: "Empagliflozin 10 mg",
          reason: "for your heart and diabetes",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex1-amoxclav-am",
          name: "Amoxicillin-clavulanate 875/125 mg",
          reason: "for your lung infection",
          flag: "NEW, for 3 more days only",
          trackable: true,
        },
        {
          id: "med-ex1-metoprolol-am",
          name: "Metoprolol succinate 50 mg",
          reason: "for your heart",
          trackable: true,
        },
        {
          id: "med-ex1-apixaban-am",
          name: "Apixaban 5 mg",
          reason: "blood thinner",
          trackable: true,
        },
        {
          id: "med-ex1-metformin-am",
          name: "Metformin 500 mg",
          reason: "for diabetes",
          trackable: true,
        },
      ]),
      group("evening", [
        {
          id: "med-ex1-amoxclav-pm",
          name: "Amoxicillin-clavulanate 875/125 mg",
          reason: "for your lung infection",
          flag: "NEW, for 3 more days only",
          trackable: true,
        },
        {
          id: "med-ex1-apixaban-pm",
          name: "Apixaban 5 mg",
          reason: "blood thinner",
          trackable: true,
        },
        {
          id: "med-ex1-metformin-pm",
          name: "Metformin 500 mg",
          reason: "for diabetes",
          trackable: true,
        },
      ]),
      group("bedtime", [
        {
          id: "med-ex1-atorvastatin-hs",
          name: "Atorvastatin 40 mg",
          reason: "for cholesterol",
          trackable: true,
        },
      ]),
    ],
  },
  newMedicines: [
    {
      name: "Furosemide 40 mg once a day",
      detail: "A water pill — take it in the morning.",
    },
    {
      name: "Losartan 25 mg once a day",
      detail: "Replaces lisinopril. Do not take lisinopril anymore.",
    },
    { name: "Empagliflozin 10 mg once a day", detail: "For your heart and diabetes." },
    {
      name: "Amoxicillin-clavulanate 875/125 mg twice a day for 3 more days",
      detail: "An antibiotic for your lung infection. Take every dose until it is finished.",
    },
  ],
  stoppedMedicines: [
    {
      name: "Lisinopril",
      detail: "STOPPED. Losartan replaces it — do not take both.",
    },
    {
      name: "Spironolactone",
      detail: "On HOLD until your kidneys and potassium are checked.",
    },
    {
      name: "NSAIDs (ibuprofen, naproxen)",
      detail: "Do not take these — they can harm your heart and kidneys.",
    },
  ],
  todos: {
    labs: [
      {
        id: "lab-ex1-kidney",
        label: "Blood test for your kidneys (creatinine) and potassium",
        detail:
          "Before or at your doctor visit in about 1 week. It checks the new medicines are safe, checks metformin, and helps decide when to restart spironolactone.",
      },
    ],
    appointments: [
      {
        id: "appt-ex1-primary",
        label: "Regular doctor (primary care)",
        detail: "In about 1 week.",
      },
      {
        id: "appt-ex1-cardiology",
        label: "Heart doctor (cardiology)",
        detail: "In about 1 week.",
      },
    ],
    appointmentsNote:
      "If you do not have a date for any of these yet, call the office to schedule it.",
    careInstructions: [
      {
        id: "care-ex1-weight",
        label: "Check your weight every morning and write it down",
        detail: "Bring the numbers to your appointment.",
      },
    ],
  },
  generalInstructions: [
    "Ask your heart team how much weight gain should make you call them.",
    "Eat less salt — aim for about 2,000 mg of sodium a day.",
    "Limit fluids as your heart team advises.",
    "Finish all of your antibiotic.",
    "Do not take NSAIDs (ibuprofen, naproxen).",
    "Ask your doctor before starting any new medicine.",
    "Tell your doctors and dentist that you take a blood thinner.",
    "Call for bleeding that will not stop, red or black poop, red or brown pee, or vomiting blood.",
    "Call your heart team for fast weight gain, worse swelling, or worse breathing.",
  ],
  warningSigns: {
    heading: "Get help RIGHT AWAY for:",
    signs: [
      "New or worse trouble breathing, mostly at rest",
      "Chest pain or pressure",
      "Fainting or feeling very dizzy",
      "Legs or belly swelling fast",
      "Peeing much less than usual",
      "New confusion or feeling very weak",
      "Fever or a cough that gets worse while on the antibiotic",
    ],
    emergencyLine: "If it feels like an emergency, call 911.",
  },
  whyHospitalized: [
    "Your heart failure got worse, with fluid in your lungs and legs and low oxygen.",
    "You had pneumonia (a lung infection).",
    "Your kidneys were stressed and are getting better.",
  ],
}

// ── Example 2 — Sepsis / Complicated UTI / Ureteral Stent ──
const example2En: DischargePlan = {
  title: "Your Care Plan",
  medications: {
    intro: MED_INTRO,
    groups: [
      group("morning", [
        {
          id: "med-ex2-cefpodoxime-am",
          name: "Cefpodoxime 200 mg",
          reason: "antibiotic",
          flag: "NEW, for 7 more days only",
          trackable: true,
        },
        {
          id: "med-ex2-tamsulosin-am",
          name: "Tamsulosin 0.4 mg",
          reason: "while your stent is in place",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex2-amlodipine-am",
          name: "Amlodipine 5 mg",
          reason: "for your blood pressure",
          trackable: true,
        },
      ]),
      group("evening", [
        {
          id: "med-ex2-cefpodoxime-pm",
          name: "Cefpodoxime 200 mg",
          reason: "antibiotic",
          flag: "NEW, for 7 more days only",
          trackable: true,
        },
      ]),
      group("bedtime", [
        {
          id: "med-ex2-atorvastatin-hs",
          name: "Atorvastatin 20 mg",
          reason: "for cholesterol",
          trackable: true,
        },
      ]),
      group("perHospitalList", [
        {
          id: "med-ex2-diabetes-list",
          name: "Your usual diabetes medicines",
          reason: "take as your hospital medicine list says",
          trackable: true,
        },
      ]),
      group("asNeeded", [
        {
          id: "med-ex2-acetaminophen-prn",
          name: "Acetaminophen (Tylenol)",
          reason: "for mild pain or fever",
          flag: "NEW",
          trackable: false,
        },
      ]),
    ],
  },
  newMedicines: [
    {
      name: "Cefpodoxime 200 mg twice a day for 7 more days",
      detail: "An antibiotic. Take every dose until it is finished.",
    },
    {
      name: "Tamsulosin 0.4 mg once a day",
      detail: "Take this while your stent is in place.",
    },
    {
      name: "Acetaminophen (Tylenol) only when needed",
      detail: "For mild pain or fever. Do not take more than the dose you were told.",
    },
  ],
  stoppedMedicines: [
    {
      name: "Lisinopril",
      detail: "On HOLD until your kidneys and blood pressure are checked.",
    },
    {
      name: "NSAIDs (ibuprofen, naproxen)",
      detail: "Do not take these — they can harm your kidneys.",
    },
  ],
  todos: {
    labs: [
      {
        id: "lab-ex2-kidney",
        label: "Blood test to check your kidneys",
        detail: "When your doctor tells you. It helps decide when to restart lisinopril.",
      },
    ],
    appointments: [
      {
        id: "appt-ex2-urology",
        label: "Urology doctor",
        detail:
          "To treat the kidney stone and remove or change the stent. The stent cannot stay forever — do not skip this even if you have no pain.",
      },
    ],
    appointmentsNote:
      "If you do not have a date for any of these yet, call the office to schedule it.",
    careInstructions: [
      {
        id: "care-ex2-bloodsugar",
        label: "Check your blood sugar as your diabetes plan says",
      },
    ],
  },
  generalInstructions: [
    "Finish all of your antibiotic.",
    "Drink enough fluids unless you were told to limit them.",
    "Do not take NSAIDs (ibuprofen, naproxen).",
    "Do not take more acetaminophen than you were told.",
    "The stent can cause a frequent or sudden urge to pee; mild pink pee or some side discomfort can be normal. The warning signs below are NOT normal.",
  ],
  warningSigns: {
    heading: "Get help RIGHT AWAY for:",
    signs: [
      "Fever or shaking chills",
      "Side or belly pain that gets worse",
      "Vomiting that will not stop, or you cannot keep your medicines down",
      "Confusion, fainting, feeling very weak, or trouble breathing",
      "Peeing much less than usual",
      "Signs the infection is back (burning when you pee, or you cannot pee)",
    ],
    emergencyLine: "If it feels like an emergency, call 911.",
  },
  whyHospitalized: [
    "A kidney stone blocked drainage from your left kidney.",
    "You had a serious urine and kidney infection that spread to your blood (sepsis).",
    "A stent was placed to let your kidney drain.",
    "Your kidneys were stressed and are almost back to normal now.",
  ],
}

// ── Example 3 — HFpEF / AFib / Cellulitis ──
const example3En: DischargePlan = {
  title: "Your Care Plan",
  medications: {
    intro: MED_INTRO,
    groups: [
      group("morning", [
        {
          id: "med-ex3-torsemide-am",
          name: "Torsemide 20 mg",
          reason: "removes extra fluid",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex3-metoprolol-am",
          name: "Metoprolol succinate 75 mg",
          reason: "slows your heartbeat",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex3-empagliflozin-am",
          name: "Empagliflozin 10 mg",
          reason: "for your heart",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex3-cephalexin-am",
          name: "Cephalexin 500 mg",
          reason: "antibiotic for your leg infection",
          flag: "NEW, for 4 more days only",
          trackable: true,
        },
        {
          id: "med-ex3-apixaban-am",
          name: "Apixaban 5 mg",
          reason: "blood thinner",
          trackable: true,
        },
      ]),
      group("afternoon", [
        {
          id: "med-ex3-cephalexin-noon",
          name: "Cephalexin 500 mg",
          reason: "antibiotic for your leg infection",
          flag: "NEW, for 4 more days only",
          trackable: true,
        },
      ]),
      group("evening", [
        {
          id: "med-ex3-cephalexin-pm",
          name: "Cephalexin 500 mg",
          reason: "antibiotic for your leg infection",
          flag: "NEW, for 4 more days only",
          trackable: true,
        },
        {
          id: "med-ex3-apixaban-pm",
          name: "Apixaban 5 mg",
          reason: "blood thinner",
          trackable: true,
        },
      ]),
      group("bedtime", [
        {
          id: "med-ex3-cephalexin-hs",
          name: "Cephalexin 500 mg",
          reason: "antibiotic for your leg infection",
          flag: "NEW, for 4 more days only",
          trackable: true,
        },
        {
          id: "med-ex3-atorvastatin-hs",
          name: "Atorvastatin (dose per hospital list)",
          reason: "for cholesterol",
          trackable: true,
        },
      ]),
      group("perHospitalList", [
        {
          id: "med-ex3-amlodipine-list",
          name: "Amlodipine",
          reason: "for your blood pressure",
          trackable: true,
        },
        {
          id: "med-ex3-diabetes-list",
          name: "Your usual diabetes medicines",
          reason: "take as your hospital medicine list says",
          trackable: true,
        },
      ]),
    ],
  },
  newMedicines: [
    {
      name: "Torsemide 20 mg once a day",
      detail: "Replaces furosemide. Do not take furosemide anymore.",
    },
    {
      name: "Metoprolol succinate 75 mg once a day",
      detail: "Replaces your old short-acting metoprolol. Do not take both.",
    },
    { name: "Empagliflozin 10 mg once a day", detail: "For your heart." },
    {
      name: "Cephalexin 500 mg four times a day for 4 more days",
      detail: "An antibiotic for your leg infection. Take every dose until it is finished.",
    },
  ],
  stoppedMedicines: [
    {
      name: "Furosemide",
      detail: "STOPPED. Torsemide replaces it — do not take both.",
    },
    {
      name: "Old short-acting metoprolol (tartrate)",
      detail: "STOPPED. The succinate form replaces it — do not take both.",
    },
  ],
  todos: {
    labs: [
      {
        id: "lab-ex3-kidney",
        label: "Blood test for your kidneys and electrolytes",
        detail: "As ordered. It checks that the new water pill is safe.",
      },
    ],
    appointments: [
      { id: "appt-ex3-cardiology", label: "Heart doctor (cardiology)" },
      { id: "appt-ex3-primary", label: "Regular doctor (primary care)" },
    ],
    appointmentsNote:
      "If you do not have a date for any of these yet, call the office to schedule it.",
    careInstructions: [
      { id: "care-ex3-weight", label: "Check your weight every morning" },
      {
        id: "care-ex3-leg",
        label: "Check your right leg every day",
        detail: "The redness, warmth, and swelling should keep improving.",
      },
      { id: "care-ex3-elevate", label: "Raise your right leg when resting" },
    ],
  },
  generalInstructions: [
    "Ask your heart team how much weight gain should make you call them.",
    "Eat less salt.",
    "Finish all of your antibiotic.",
    "Take apixaban exactly as prescribed. Do not stop it unless your doctor tells you to.",
    "Get up slowly and use your walking aid to prevent falls.",
  ],
  warningSigns: {
    heading: "Get help RIGHT AWAY for:",
    signs: [
      "New chest pain",
      "Severe or worsening shortness of breath",
      "Fainting or almost fainting",
      "A fast or irregular heartbeat that will not stop and makes you feel unwell",
      "Swelling or weight going up fast",
      "Redness spreading past the marked area, or leg pain that gets worse fast",
      "New fever, chills, confusion, or feeling very weak",
      "Serious bleeding while on your blood thinner",
    ],
    emergencyLine: "If it feels like an emergency, call 911.",
  },
  whyHospitalized: [
    "Your heart failure got worse and fluid built up — about 10 lb, with swollen legs and trouble breathing when lying flat.",
    "You had a fast, irregular heartbeat (AFib).",
    "You had a skin infection on your right leg (cellulitis).",
  ],
}

// ── Example 4 — COPD / Pneumonia / Heart Failure ──
const example4En: DischargePlan = {
  title: "Your Care Plan",
  medications: {
    intro: MED_INTRO,
    groups: [
      group("morning", [
        {
          id: "med-ex4-furosemide-am",
          name: "Furosemide 40 mg",
          reason: "removes extra fluid",
          flag: "NEW, higher dose until your doctor visit",
          trackable: true,
        },
        {
          id: "med-ex4-prednisone-am",
          name: "Prednisone 40 mg",
          reason: "a steroid for your COPD flare",
          flag: "NEW, for 2 more days only",
          trackable: true,
        },
        {
          id: "med-ex4-doxycycline-am",
          name: "Doxycycline 100 mg",
          reason: "antibiotic for your lung infection",
          flag: "NEW, for 3 more days only",
          trackable: true,
        },
      ]),
      group("evening", [
        {
          id: "med-ex4-doxycycline-pm",
          name: "Doxycycline 100 mg",
          reason: "antibiotic for your lung infection",
          flag: "NEW, for 3 more days only",
          trackable: true,
        },
      ]),
      group("perHospitalList", [
        {
          id: "med-ex4-inhaler-list",
          name: "Daily maintenance inhaler",
          reason: "use every day",
          trackable: true,
        },
        {
          id: "med-ex4-carvedilol-list",
          name: "Carvedilol",
          reason: "for your heart",
          trackable: true,
        },
        {
          id: "med-ex4-other-list",
          name: "Your other usual medicines",
          reason: "take as your hospital medicine list says",
          trackable: true,
        },
      ]),
      group("asNeeded", [
        {
          id: "med-ex4-albuterol-prn",
          name: "Albuterol rescue inhaler",
          reason: "for sudden shortness of breath",
          trackable: false,
        },
      ]),
    ],
  },
  newMedicines: [
    {
      name: "Furosemide 40 mg once a day",
      detail: "This is a HIGHER dose. Take it until your doctor visit, then ask what to do.",
    },
    {
      name: "Prednisone 40 mg once a day for 2 more days",
      detail: "A steroid for your COPD flare. Then stop.",
    },
    {
      name: "Doxycycline 100 mg twice a day for 3 more days",
      detail: "An antibiotic. Take every dose until it is finished.",
    },
  ],
  stoppedMedicines: [
    {
      name: "Your old lower-dose furosemide",
      detail: "Do not take it for now. Take only the 40 mg dose until you are told otherwise.",
    },
  ],
  todos: {
    labs: [],
    appointments: [
      { id: "appt-ex4-primary", label: "Regular doctor (primary care)" },
      { id: "appt-ex4-pulmonology", label: "Lung doctor (pulmonology)" },
      { id: "appt-ex4-cardiology", label: "Heart doctor (cardiology)" },
    ],
    appointmentsNote:
      "If you do not have a date for any of these yet, call the office to schedule it.",
    careInstructions: [
      { id: "care-ex4-weight", label: "Check your weight every morning" },
      {
        id: "care-ex4-oxygen",
        label: "Use your oxygen at the prescribed flow and times",
        detail: "Use it with activity and sleep as ordered.",
      },
    ],
  },
  generalInstructions: [
    "Use your daily inhaler every day. Use the rescue inhaler only for sudden trouble breathing.",
    "Finish all of your prednisone and antibiotic.",
    "Ask your heart team how much weight gain should make you call them.",
    "Eat less salt.",
    "Stop smoking — ask for help quitting.",
    "Never smoke near oxygen and keep it away from flames.",
  ],
  warningSigns: {
    heading: "Call 911 or go to the emergency room for:",
    signs: [
      "Severe shortness of breath that does not get better with your rescue inhaler",
      "New or worse chest pain",
      "Blue or gray lips, or being too breathless to talk",
      "New confusion or not being able to stay awake",
      "Needing much more oxygen than usual",
      "A high fever, or a cough with mucus that gets worse fast",
      "Weight going up fast with more swelling or trouble breathing when lying flat",
    ],
    emergencyLine: "If it feels like an emergency, call 911.",
  },
  whyHospitalized: [
    "Your COPD flared and your blood oxygen was low.",
    "You had pneumonia (a lung infection).",
    "Your heart failure got worse with extra fluid.",
  ],
}

// ── Example 5 — Endocarditis / Heart Failure / IV Antibiotics ──
const example5En: DischargePlan = {
  title: "Your Care Plan",
  medications: {
    intro: MED_INTRO,
    groups: [
      group("morning", [
        {
          id: "med-ex5-furosemide-am",
          name: "Furosemide 40 mg",
          reason: "removes extra fluid",
          flag: "NEW",
          trackable: true,
        },
        {
          id: "med-ex5-losartan-am",
          name: "Losartan 25 mg",
          reason: "for your heart",
          flag: "NEW",
          trackable: true,
        },
      ]),
      group("iv", [
        {
          id: "med-ex5-cefazolin-iv",
          name: "Cefazolin through your IV line",
          reason: "for your heart valve infection",
          flag: "NEW, on the schedule your infection doctor and IV team set",
          trackable: true,
        },
      ]),
      group("perHospitalList", [
        {
          id: "med-ex5-metoprolol-list",
          name: "Metoprolol succinate",
          reason: "for your heart",
          trackable: true,
        },
        {
          id: "med-ex5-other-list",
          name: "Your other usual medicines",
          reason: "take as your hospital medicine list says",
          trackable: true,
        },
      ]),
    ],
  },
  newMedicines: [
    {
      name: "Cefazolin through your IV line",
      detail:
        "An antibiotic for your heart valve infection. Your infection doctor set the dose and schedule. Take every dose until the whole course is done — do not stop or change it on your own.",
    },
    {
      name: "Furosemide 40 mg once a day",
      detail: "A water pill — it will make you pee more.",
    },
    {
      name: "Losartan 25 mg once a day",
      detail: "A low starting dose for your heart.",
    },
  ],
  stoppedMedicines: [
    {
      name: "NSAIDs (ibuprofen, naproxen)",
      detail: "Do not take these unless your doctor says it is OK.",
    },
  ],
  todos: {
    labs: [
      {
        id: "lab-ex5-program",
        label: "Blood tests",
        detail: "As scheduled by your IV antibiotic program.",
      },
    ],
    appointments: [
      { id: "appt-ex5-id", label: "Infection doctor (infectious disease)" },
      { id: "appt-ex5-cardiology", label: "Heart doctor (cardiology)" },
      { id: "appt-ex5-infusion", label: "IV antibiotic (infusion) visits" },
      { id: "appt-ex5-picc", label: "IV line (PICC) care visits" },
    ],
    appointmentsNote:
      "If you do not have a date for any of these yet, call the office to schedule it.",
    careInstructions: [
      {
        id: "care-ex5-weight",
        label: "Check your weight every morning and write it down",
      },
      {
        id: "care-ex5-picc",
        label: "Care for your IV line (PICC) as your nurse showed you",
      },
    ],
  },
  generalInstructions: [
    "Finish the whole IV antibiotic course. Do not stop or change it on your own.",
    "Keep your IV team's phone number close.",
    "Ask your heart team how much weight gain should make you call them.",
    "Eat less salt and follow your fluid plan.",
    "Follow your activity limits.",
    "Follow your doctor's advice before any dental work or procedures.",
    "Do not take NSAIDs (ibuprofen, naproxen).",
  ],
  warningSigns: {
    heading: "Get help RIGHT AWAY for:",
    signs: [
      "Fever, chills, or feeling sick again",
      "New or worse shortness of breath",
      "Chest pain",
      "Fainting or feeling very dizzy",
      "Weakness, a drooping face, trouble speaking, or confusion",
      "Swelling or weight going up fast",
      "Bleeding, fluid, or redness around your IV line",
      "Sudden severe pain in your back, chest, or belly",
      "Any problem with your IV line",
    ],
    emergencyLine: "If it feels like an emergency, call 911.",
  },
  whyHospitalized: [
    "You had an infection on a heart valve (the mitral valve) from staph bacteria in your blood.",
    "The valve leaked and your heart failure got worse, with fluid in your lungs.",
    "You need a long course of IV antibiotics to clear the infection.",
  ],
}

// ── Per-language text tables (mock translations) ──
// Spanish is genuinely accurate; Mandarin and Arabic are plausible mock
// translations (never English, never a placeholder). translatePlan() zips each
// table with the matching English plan so opaque ids stay identical.

// Example 1 — HFrEF / Pneumonia / AKI
const example1Text: Record<"es" | "zh" | "ar", PlanText> = {
  es: {
    title: "Su plan de atención",
    medicationsIntro: "Estos son todos los medicamentos que debe tomar ahora.",
    medGroups: [
      {
        items: [
          { name: "Furosemida 40 mg", reason: "elimina el líquido extra", flag: "NUEVO" },
          { name: "Losartán 25 mg", reason: "para su corazón y presión arterial", flag: "NUEVO" },
          { name: "Empagliflozina 10 mg", reason: "para su corazón y la diabetes", flag: "NUEVO" },
          { name: "Amoxicilina-clavulánico 875/125 mg", reason: "para su infección pulmonar", flag: "NUEVO, solo por 3 días más" },
          { name: "Metoprolol succinato 50 mg", reason: "para su corazón" },
          { name: "Apixabán 5 mg", reason: "anticoagulante" },
          { name: "Metformina 500 mg", reason: "para la diabetes" },
        ],
      },
      {
        items: [
          { name: "Amoxicilina-clavulánico 875/125 mg", reason: "para su infección pulmonar", flag: "NUEVO, solo por 3 días más" },
          { name: "Apixabán 5 mg", reason: "anticoagulante" },
          { name: "Metformina 500 mg", reason: "para la diabetes" },
        ],
      },
      {
        items: [
          { name: "Atorvastatina 40 mg", reason: "para el colesterol" },
        ],
      },
    ],
    newMedicines: [
      { name: "Furosemida 40 mg una vez al día", detail: "Una pastilla de agua: tómela por la mañana." },
      { name: "Losartán 25 mg una vez al día", detail: "Reemplaza al lisinopril. Ya no tome lisinopril." },
      { name: "Empagliflozina 10 mg una vez al día", detail: "Para su corazón y la diabetes." },
      { name: "Amoxicilina-clavulánico 875/125 mg dos veces al día por 3 días más", detail: "Un antibiótico para su infección pulmonar. Tome cada dosis hasta terminarlo." },
    ],
    stoppedMedicines: [
      { name: "Lisinopril", detail: "SUSPENDIDO. El losartán lo reemplaza: no tome ambos." },
      { name: "Espironolactona", detail: "EN PAUSA hasta que revisen sus riñones y su potasio." },
      { name: "AINE (ibuprofeno, naproxeno)", detail: "No los tome: pueden dañar su corazón y sus riñones." },
    ],
    labs: [
      { label: "Análisis de sangre para sus riñones (creatinina) y potasio", detail: "Antes o durante su visita médica en aproximadamente 1 semana. Verifica que los nuevos medicamentos sean seguros, revisa la metformina y ayuda a decidir cuándo reiniciar la espironolactona." },
    ],
    appointments: [
      { label: "Médico de cabecera (atención primaria)", detail: "En aproximadamente 1 semana." },
      { label: "Cardiólogo (médico del corazón)", detail: "En aproximadamente 1 semana." },
    ],
    appointmentsNote: "Si aún no tiene fecha para alguna de estas citas, llame al consultorio para programarla.",
    careInstructions: [
      { label: "Pésese cada mañana y anote el peso", detail: "Lleve los números a su cita." },
    ],
    generalInstructions: [
      "Pregunte a su equipo del corazón cuánto aumento de peso debe hacer que los llame.",
      "Coma menos sal: procure unos 2,000 mg de sodio al día.",
      "Limite los líquidos según lo indique su equipo del corazón.",
      "Termine todo su antibiótico.",
      "No tome AINE (ibuprofeno, naproxeno).",
      "Pregunte a su médico antes de empezar cualquier medicamento nuevo.",
      "Diga a sus médicos y dentista que toma un anticoagulante.",
      "Llame si hay sangrado que no se detiene, heces rojas o negras, orina roja o marrón, o vómito con sangre.",
      "Llame a su equipo del corazón si aumenta de peso rápido, empeora la hinchazón o la dificultad para respirar.",
    ],
    warningHeading: "Busque ayuda DE INMEDIATO si tiene:",
    warningSigns: [
      "Dificultad para respirar nueva o peor, sobre todo en reposo",
      "Dolor o presión en el pecho",
      "Desmayos o mareos intensos",
      "Hinchazón rápida de piernas o abdomen",
      "Orinar mucho menos de lo normal",
      "Confusión nueva o sentirse muy débil",
      "Fiebre o tos que empeora mientras toma el antibiótico",
    ],
    emergencyLine: "Si parece una emergencia, llame al 911.",
    whyHospitalized: [
      "Su insuficiencia cardíaca empeoró, con líquido en los pulmones y las piernas y poco oxígeno.",
      "Tuvo neumonía (una infección pulmonar).",
      "Sus riñones estuvieron bajo estrés y están mejorando.",
    ],
  },
  zh: {
    title: "您的护理计划",
    medicationsIntro: "这些是您现在应该服用的所有药物。",
    medGroups: [
      {
        items: [
          { name: "呋塞米 40 毫克", reason: "排出多余的体液", flag: "新药" },
          { name: "氯沙坦 25 毫克", reason: "用于您的心脏和血压", flag: "新药" },
          { name: "恩格列净 10 毫克", reason: "用于您的心脏和糖尿病", flag: "新药" },
          { name: "阿莫西林-克拉维酸 875/125 毫克", reason: "用于您的肺部感染", flag: "新药，仅再服用 3 天" },
          { name: "琥珀酸美托洛尔 50 毫克", reason: "用于您的心脏" },
          { name: "阿哌沙班 5 毫克", reason: "抗凝血药" },
          { name: "二甲双胍 500 毫克", reason: "用于糖尿病" },
        ],
      },
      {
        items: [
          { name: "阿莫西林-克拉维酸 875/125 毫克", reason: "用于您的肺部感染", flag: "新药，仅再服用 3 天" },
          { name: "阿哌沙班 5 毫克", reason: "抗凝血药" },
          { name: "二甲双胍 500 毫克", reason: "用于糖尿病" },
        ],
      },
      {
        items: [
          { name: "阿托伐他汀 40 毫克", reason: "用于胆固醇" },
        ],
      },
    ],
    newMedicines: [
      { name: "呋塞米 40 毫克，每日一次", detail: "一种利尿药——请在早晨服用。" },
      { name: "氯沙坦 25 毫克，每日一次", detail: "替代赖诺普利。请不要再服用赖诺普利。" },
      { name: "恩格列净 10 毫克，每日一次", detail: "用于您的心脏和糖尿病。" },
      { name: "阿莫西林-克拉维酸 875/125 毫克，每日两次，再服用 3 天", detail: "一种治疗肺部感染的抗生素。请服完每一剂直至用完。" },
    ],
    stoppedMedicines: [
      { name: "赖诺普利", detail: "已停用。由氯沙坦替代——不要同时服用两者。" },
      { name: "螺内酯", detail: "暂停，直到检查您的肾脏和血钾。" },
      { name: "非甾体抗炎药（布洛芬、萘普生）", detail: "请勿服用——它们可能损害您的心脏和肾脏。" },
    ],
    labs: [
      { label: "检查肾脏（肌酐）和血钾的血液检验", detail: "在约 1 周后的就诊之前或当天进行。它可确认新药安全、检查二甲双胍，并帮助决定何时重新开始螺内酯。" },
    ],
    appointments: [
      { label: "家庭医生（初级保健）", detail: "大约 1 周后。" },
      { label: "心脏科医生（心脏病科）", detail: "大约 1 周后。" },
    ],
    appointmentsNote: "如果您还没有任何一个的日期，请致电诊所预约。",
    careInstructions: [
      { label: "每天早上称体重并记录下来", detail: "就诊时请带上这些数字。" },
    ],
    generalInstructions: [
      "询问您的心脏团队，体重增加多少时应打电话给他们。",
      "少吃盐——每天钠摄入量约 2,000 毫克。",
      "按照心脏团队的建议限制液体摄入。",
      "服完所有抗生素。",
      "不要服用非甾体抗炎药（布洛芬、萘普生）。",
      "开始服用任何新药前先询问医生。",
      "告知您的医生和牙医您正在服用抗凝血药。",
      "如出现止不住的出血、红色或黑色大便、红色或棕色小便或呕血，请致电。",
      "如体重快速增加、水肿加重或呼吸变差，请致电您的心脏团队。",
    ],
    warningHeading: "出现以下情况请立即就医：",
    warningSigns: [
      "新出现或加重的呼吸困难，尤其在休息时",
      "胸痛或胸闷",
      "昏厥或严重头晕",
      "腿部或腹部迅速肿胀",
      "排尿比平时明显减少",
      "新出现的意识混乱或非常虚弱",
      "服用抗生素期间发烧或咳嗽加重",
    ],
    emergencyLine: "如果像是紧急情况，请拨打 911。",
    whyHospitalized: [
      "您的心力衰竭加重，肺部和腿部积液，血氧偏低。",
      "您患了肺炎（肺部感染）。",
      "您的肾脏受到负担，正在好转。",
    ],
  },
  ar: {
    title: "خطة رعايتك",
    medicationsIntro: "هذه كل الأدوية التي يجب أن تتناولها الآن.",
    medGroups: [
      {
        items: [
          { name: "فوروسيميد 40 ملغ", reason: "يزيل السوائل الزائدة", flag: "جديد" },
          { name: "لوسارتان 25 ملغ", reason: "لقلبك وضغط دمك", flag: "جديد" },
          { name: "إمباغليفلوزين 10 ملغ", reason: "لقلبك والسكري", flag: "جديد" },
          { name: "أموكسيسيلين-كلافولانيك 875/125 ملغ", reason: "لعدوى الرئة لديك", flag: "جديد، لمدة 3 أيام فقط" },
          { name: "ميتوبرولول سكسينات 50 ملغ", reason: "لقلبك" },
          { name: "أبيكسابان 5 ملغ", reason: "مميّع للدم" },
          { name: "ميتفورمين 500 ملغ", reason: "للسكري" },
        ],
      },
      {
        items: [
          { name: "أموكسيسيلين-كلافولانيك 875/125 ملغ", reason: "لعدوى الرئة لديك", flag: "جديد، لمدة 3 أيام فقط" },
          { name: "أبيكسابان 5 ملغ", reason: "مميّع للدم" },
          { name: "ميتفورمين 500 ملغ", reason: "للسكري" },
        ],
      },
      {
        items: [
          { name: "أتورفاستاتين 40 ملغ", reason: "للكوليسترول" },
        ],
      },
    ],
    newMedicines: [
      { name: "فوروسيميد 40 ملغ مرة واحدة يومياً", detail: "حبة مدرّة للبول — تناولها في الصباح." },
      { name: "لوسارتان 25 ملغ مرة واحدة يومياً", detail: "يحل محل ليسينوبريل. لا تتناول ليسينوبريل بعد الآن." },
      { name: "إمباغليفلوزين 10 ملغ مرة واحدة يومياً", detail: "لقلبك والسكري." },
      { name: "أموكسيسيلين-كلافولانيك 875/125 ملغ مرتين يومياً لمدة 3 أيام إضافية", detail: "مضاد حيوي لعدوى الرئة. تناول كل جرعة حتى تنتهي الكمية." },
    ],
    stoppedMedicines: [
      { name: "ليسينوبريل", detail: "متوقف. اللوسارتان يحل محله — لا تتناول كليهما." },
      { name: "سبيرونولاكتون", detail: "معلّق حتى يتم فحص كليتيك والبوتاسيوم." },
      { name: "مضادات الالتهاب (إيبوبروفين، نابروكسين)", detail: "لا تتناولها — فقد تضر قلبك وكليتيك." },
    ],
    labs: [
      { label: "تحليل دم للكلى (الكرياتينين) والبوتاسيوم", detail: "قبل أو أثناء زيارة الطبيب بعد نحو أسبوع. يتحقق من سلامة الأدوية الجديدة، ويراقب الميتفورمين، ويساعد في تحديد موعد استئناف السبيرونولاكتون." },
    ],
    appointments: [
      { label: "طبيب العائلة (الرعاية الأولية)", detail: "بعد نحو أسبوع." },
      { label: "طبيب القلب", detail: "بعد نحو أسبوع." },
    ],
    appointmentsNote: "إذا لم يكن لديك موعد لأي منها بعد، اتصل بالعيادة لتحديده.",
    careInstructions: [
      { label: "زن نفسك كل صباح ودوّن الوزن", detail: "أحضر الأرقام إلى موعدك." },
    ],
    generalInstructions: [
      "اسأل فريق القلب عن مقدار زيادة الوزن الذي يستوجب الاتصال بهم.",
      "قلّل الملح — استهدف نحو 2,000 ملغ من الصوديوم يومياً.",
      "حدّد السوائل حسب نصيحة فريق القلب.",
      "أكمل كل المضاد الحيوي.",
      "لا تتناول مضادات الالتهاب (إيبوبروفين، نابروكسين).",
      "اسأل طبيبك قبل البدء بأي دواء جديد.",
      "أخبر أطباءك وطبيب أسنانك أنك تتناول مميّعاً للدم.",
      "اتصل عند نزيف لا يتوقف، أو براز أحمر أو أسود، أو بول أحمر أو بني، أو تقيؤ دم.",
      "اتصل بفريق القلب عند زيادة سريعة في الوزن أو ازدياد التورم أو صعوبة التنفس.",
    ],
    warningHeading: "اطلب المساعدة فوراً عند:",
    warningSigns: [
      "صعوبة تنفس جديدة أو أسوأ، خاصة أثناء الراحة",
      "ألم أو ضغط في الصدر",
      "إغماء أو دوخة شديدة",
      "تورم سريع في الساقين أو البطن",
      "تبوّل أقل بكثير من المعتاد",
      "تشوش ذهني جديد أو شعور بضعف شديد",
      "حمى أو سعال يزداد سوءاً أثناء تناول المضاد الحيوي",
    ],
    emergencyLine: "إذا بدا الأمر حالة طارئة، اتصل بـ 911.",
    whyHospitalized: [
      "ساءت حالة قصور القلب لديك، مع سوائل في الرئتين والساقين وانخفاض الأكسجين.",
      "أصبت بالتهاب رئوي (عدوى في الرئة).",
      "تعرضت كليتاك للإجهاد وهما تتحسنان.",
    ],
  },
}

// Example 2 — Sepsis / Complicated UTI / Ureteral Stent
const example2Text: Record<"es" | "zh" | "ar", PlanText> = {
  es: {
    title: "Su plan de atención",
    medicationsIntro: "Estos son todos los medicamentos que debe tomar ahora.",
    medGroups: [
      {
        items: [
          { name: "Cefpodoxima 200 mg", reason: "antibiótico", flag: "NUEVO, solo por 7 días más" },
          { name: "Tamsulosina 0.4 mg", reason: "mientras tenga el stent colocado", flag: "NUEVO" },
          { name: "Amlodipino 5 mg", reason: "para su presión arterial" },
        ],
      },
      {
        items: [
          { name: "Cefpodoxima 200 mg", reason: "antibiótico", flag: "NUEVO, solo por 7 días más" },
        ],
      },
      {
        items: [
          { name: "Atorvastatina 20 mg", reason: "para el colesterol" },
        ],
      },
      {
        items: [
          { name: "Sus medicamentos habituales para la diabetes", reason: "tómelos según su lista de medicamentos del hospital" },
        ],
      },
      {
        items: [
          { name: "Acetaminofén (Tylenol)", reason: "para dolor leve o fiebre", flag: "NUEVO" },
        ],
      },
    ],
    newMedicines: [
      { name: "Cefpodoxima 200 mg dos veces al día por 7 días más", detail: "Un antibiótico. Tome cada dosis hasta terminarlo." },
      { name: "Tamsulosina 0.4 mg una vez al día", detail: "Tómela mientras tenga el stent colocado." },
      { name: "Acetaminofén (Tylenol) solo cuando sea necesario", detail: "Para dolor leve o fiebre. No tome más de la dosis indicada." },
    ],
    stoppedMedicines: [
      { name: "Lisinopril", detail: "EN PAUSA hasta que revisen sus riñones y su presión arterial." },
      { name: "AINE (ibuprofeno, naproxeno)", detail: "No los tome: pueden dañar sus riñones." },
    ],
    labs: [
      { label: "Análisis de sangre para revisar sus riñones", detail: "Cuando su médico se lo indique. Ayuda a decidir cuándo reiniciar el lisinopril." },
    ],
    appointments: [
      { label: "Urólogo", detail: "Para tratar el cálculo renal y retirar o cambiar el stent. El stent no puede quedarse para siempre: no falte aunque no tenga dolor." },
    ],
    appointmentsNote: "Si aún no tiene fecha para alguna de estas citas, llame al consultorio para programarla.",
    careInstructions: [
      { label: "Controle su azúcar en sangre según su plan de diabetes" },
    ],
    generalInstructions: [
      "Termine todo su antibiótico.",
      "Beba suficientes líquidos a menos que le hayan indicado limitarlos.",
      "No tome AINE (ibuprofeno, naproxeno).",
      "No tome más acetaminofén del indicado.",
      "El stent puede causar ganas frecuentes o repentinas de orinar; una orina rosada leve o algo de molestia lateral puede ser normal. Las señales de alarma de abajo NO son normales.",
    ],
    warningHeading: "Busque ayuda DE INMEDIATO si tiene:",
    warningSigns: [
      "Fiebre o escalofríos con temblores",
      "Dolor en el costado o el abdomen que empeora",
      "Vómitos que no paran, o no puede retener sus medicamentos",
      "Confusión, desmayos, debilidad intensa o dificultad para respirar",
      "Orinar mucho menos de lo normal",
      "Señales de que la infección volvió (ardor al orinar, o no poder orinar)",
    ],
    emergencyLine: "Si parece una emergencia, llame al 911.",
    whyHospitalized: [
      "Un cálculo renal bloqueó el drenaje de su riñón izquierdo.",
      "Tuvo una infección grave de orina y riñón que se propagó a la sangre (sepsis).",
      "Se colocó un stent para que su riñón pudiera drenar.",
      "Sus riñones estuvieron bajo estrés y ya casi están normales.",
    ],
  },
  zh: {
    title: "您的护理计划",
    medicationsIntro: "这些是您现在应该服用的所有药物。",
    medGroups: [
      {
        items: [
          { name: "头孢泊肟 200 毫克", reason: "抗生素", flag: "新药，仅再服用 7 天" },
          { name: "坦索罗辛 0.4 毫克", reason: "在支架留置期间服用", flag: "新药" },
          { name: "氨氯地平 5 毫克", reason: "用于您的血压" },
        ],
      },
      {
        items: [
          { name: "头孢泊肟 200 毫克", reason: "抗生素", flag: "新药，仅再服用 7 天" },
        ],
      },
      {
        items: [
          { name: "阿托伐他汀 20 毫克", reason: "用于胆固醇" },
        ],
      },
      {
        items: [
          { name: "您常用的糖尿病药物", reason: "按照您的医院用药清单服用" },
        ],
      },
      {
        items: [
          { name: "对乙酰氨基酚（泰诺）", reason: "用于轻度疼痛或发烧", flag: "新药" },
        ],
      },
    ],
    newMedicines: [
      { name: "头孢泊肟 200 毫克，每日两次，再服用 7 天", detail: "一种抗生素。请服完每一剂直至用完。" },
      { name: "坦索罗辛 0.4 毫克，每日一次", detail: "在支架留置期间服用。" },
      { name: "对乙酰氨基酚（泰诺）仅在需要时服用", detail: "用于轻度疼痛或发烧。不要超过被告知的剂量。" },
    ],
    stoppedMedicines: [
      { name: "赖诺普利", detail: "暂停，直到检查您的肾脏和血压。" },
      { name: "非甾体抗炎药（布洛芬、萘普生）", detail: "请勿服用——它们可能损害您的肾脏。" },
    ],
    labs: [
      { label: "检查肾脏的血液检验", detail: "在医生告知时进行。它有助于决定何时重新开始赖诺普利。" },
    ],
    appointments: [
      { label: "泌尿科医生", detail: "治疗肾结石并取出或更换支架。支架不能永久留置——即使没有疼痛也不要错过。" },
    ],
    appointmentsNote: "如果您还没有任何一个的日期，请致电诊所预约。",
    careInstructions: [
      { label: "按照您的糖尿病计划检查血糖" },
    ],
    generalInstructions: [
      "服完所有抗生素。",
      "除非被告知限制，否则请多喝水。",
      "不要服用非甾体抗炎药（布洛芬、萘普生）。",
      "对乙酰氨基酚不要超过被告知的剂量。",
      "支架可能导致尿频或突然的尿意；轻微的粉红色小便或些许侧腹不适可能是正常的。以下警示信号则不正常。",
    ],
    warningHeading: "出现以下情况请立即就医：",
    warningSigns: [
      "发烧或寒战发抖",
      "侧腹或腹部疼痛加重",
      "呕吐不止，或无法保留药物",
      "意识混乱、昏厥、非常虚弱或呼吸困难",
      "排尿比平时明显减少",
      "感染复发的迹象（排尿灼痛，或无法排尿）",
    ],
    emergencyLine: "如果像是紧急情况，请拨打 911。",
    whyHospitalized: [
      "肾结石阻塞了您左肾的引流。",
      "您患有严重的泌尿和肾脏感染，并扩散到血液（败血症）。",
      "放置了支架以让您的肾脏引流。",
      "您的肾脏曾受到负担，现在几乎恢复正常。",
    ],
  },
  ar: {
    title: "خطة رعايتك",
    medicationsIntro: "هذه كل الأدوية التي يجب أن تتناولها الآن.",
    medGroups: [
      {
        items: [
          { name: "سيفبودوكسيم 200 ملغ", reason: "مضاد حيوي", flag: "جديد، لمدة 7 أيام فقط" },
          { name: "تامسولوسين 0.4 ملغ", reason: "طالما الدعامة في مكانها", flag: "جديد" },
          { name: "أملوديبين 5 ملغ", reason: "لضغط دمك" },
        ],
      },
      {
        items: [
          { name: "سيفبودوكسيم 200 ملغ", reason: "مضاد حيوي", flag: "جديد، لمدة 7 أيام فقط" },
        ],
      },
      {
        items: [
          { name: "أتورفاستاتين 20 ملغ", reason: "للكوليسترول" },
        ],
      },
      {
        items: [
          { name: "أدوية السكري المعتادة لديك", reason: "تناولها حسب قائمة أدوية المستشفى الخاصة بك" },
        ],
      },
      {
        items: [
          { name: "أسيتامينوفين (تايلينول)", reason: "لألم خفيف أو حمى", flag: "جديد" },
        ],
      },
    ],
    newMedicines: [
      { name: "سيفبودوكسيم 200 ملغ مرتين يومياً لمدة 7 أيام إضافية", detail: "مضاد حيوي. تناول كل جرعة حتى تنتهي الكمية." },
      { name: "تامسولوسين 0.4 ملغ مرة واحدة يومياً", detail: "تناوله طالما الدعامة في مكانها." },
      { name: "أسيتامينوفين (تايلينول) عند الحاجة فقط", detail: "لألم خفيف أو حمى. لا تتجاوز الجرعة التي أُخبرت بها." },
    ],
    stoppedMedicines: [
      { name: "ليسينوبريل", detail: "معلّق حتى يتم فحص كليتيك وضغط دمك." },
      { name: "مضادات الالتهاب (إيبوبروفين، نابروكسين)", detail: "لا تتناولها — فقد تضر كليتيك." },
    ],
    labs: [
      { label: "تحليل دم لفحص كليتيك", detail: "عندما يخبرك طبيبك. يساعد في تحديد موعد استئناف ليسينوبريل." },
    ],
    appointments: [
      { label: "طبيب المسالك البولية", detail: "لعلاج حصوة الكلى وإزالة الدعامة أو تغييرها. لا يمكن أن تبقى الدعامة للأبد — لا تفوّت الموعد حتى لو لم يكن لديك ألم." },
    ],
    appointmentsNote: "إذا لم يكن لديك موعد لأي منها بعد، اتصل بالعيادة لتحديده.",
    careInstructions: [
      { label: "افحص سكر الدم حسب خطة السكري الخاصة بك" },
    ],
    generalInstructions: [
      "أكمل كل المضاد الحيوي.",
      "اشرب سوائل كافية ما لم يُطلب منك تحديدها.",
      "لا تتناول مضادات الالتهاب (إيبوبروفين، نابروكسين).",
      "لا تتجاوز جرعة الأسيتامينوفين التي أُخبرت بها.",
      "قد تسبب الدعامة رغبة متكررة أو مفاجئة في التبول؛ قد يكون البول الوردي الخفيف أو بعض الانزعاج الجانبي طبيعياً. علامات التحذير أدناه ليست طبيعية.",
    ],
    warningHeading: "اطلب المساعدة فوراً عند:",
    warningSigns: [
      "حمى أو قشعريرة مع ارتجاف",
      "ألم في الخاصرة أو البطن يزداد سوءاً",
      "تقيؤ لا يتوقف، أو عدم القدرة على إبقاء أدويتك",
      "تشوش ذهني، إغماء، ضعف شديد، أو صعوبة في التنفس",
      "تبوّل أقل بكثير من المعتاد",
      "علامات عودة العدوى (حرقة عند التبول، أو عدم القدرة على التبول)",
    ],
    emergencyLine: "إذا بدا الأمر حالة طارئة، اتصل بـ 911.",
    whyHospitalized: [
      "سدّت حصوة كلوية تصريف كليتك اليسرى.",
      "أصبت بعدوى خطيرة في البول والكلى انتشرت إلى الدم (إنتان).",
      "وُضعت دعامة للسماح لكليتك بالتصريف.",
      "تعرضت كليتاك للإجهاد وهما الآن شبه طبيعيتين.",
    ],
  },
}

// Example 3 — HFpEF / AFib / Cellulitis
const example3Text: Record<"es" | "zh" | "ar", PlanText> = {
  es: {
    title: "Su plan de atención",
    medicationsIntro: "Estos son todos los medicamentos que debe tomar ahora.",
    medGroups: [
      {
        items: [
          { name: "Torsemida 20 mg", reason: "elimina el líquido extra", flag: "NUEVO" },
          { name: "Metoprolol succinato 75 mg", reason: "disminuye su frecuencia cardíaca", flag: "NUEVO" },
          { name: "Empagliflozina 10 mg", reason: "para su corazón", flag: "NUEVO" },
          { name: "Cefalexina 500 mg", reason: "antibiótico para la infección de su pierna", flag: "NUEVO, solo por 4 días más" },
          { name: "Apixabán 5 mg", reason: "anticoagulante" },
        ],
      },
      {
        items: [
          { name: "Cefalexina 500 mg", reason: "antibiótico para la infección de su pierna", flag: "NUEVO, solo por 4 días más" },
        ],
      },
      {
        items: [
          { name: "Cefalexina 500 mg", reason: "antibiótico para la infección de su pierna", flag: "NUEVO, solo por 4 días más" },
          { name: "Apixabán 5 mg", reason: "anticoagulante" },
        ],
      },
      {
        items: [
          { name: "Cefalexina 500 mg", reason: "antibiótico para la infección de su pierna", flag: "NUEVO, solo por 4 días más" },
          { name: "Atorvastatina (dosis según la lista del hospital)", reason: "para el colesterol" },
        ],
      },
      {
        items: [
          { name: "Amlodipino", reason: "para su presión arterial" },
          { name: "Sus medicamentos habituales para la diabetes", reason: "tómelos según su lista de medicamentos del hospital" },
        ],
      },
    ],
    newMedicines: [
      { name: "Torsemida 20 mg una vez al día", detail: "Reemplaza a la furosemida. Ya no tome furosemida." },
      { name: "Metoprolol succinato 75 mg una vez al día", detail: "Reemplaza su metoprolol de acción corta anterior. No tome ambos." },
      { name: "Empagliflozina 10 mg una vez al día", detail: "Para su corazón." },
      { name: "Cefalexina 500 mg cuatro veces al día por 4 días más", detail: "Un antibiótico para la infección de su pierna. Tome cada dosis hasta terminarlo." },
    ],
    stoppedMedicines: [
      { name: "Furosemida", detail: "SUSPENDIDA. La torsemida la reemplaza: no tome ambas." },
      { name: "Metoprolol de acción corta anterior (tartrato)", detail: "SUSPENDIDO. La forma succinato lo reemplaza: no tome ambos." },
    ],
    labs: [
      { label: "Análisis de sangre para sus riñones y electrolitos", detail: "Según lo indicado. Verifica que la nueva pastilla de agua sea segura." },
    ],
    appointments: [
      { label: "Cardiólogo (médico del corazón)" },
      { label: "Médico de cabecera (atención primaria)" },
    ],
    appointmentsNote: "Si aún no tiene fecha para alguna de estas citas, llame al consultorio para programarla.",
    careInstructions: [
      { label: "Pésese cada mañana" },
      { label: "Revise su pierna derecha todos los días", detail: "El enrojecimiento, el calor y la hinchazón deben seguir mejorando." },
      { label: "Eleve su pierna derecha al descansar" },
    ],
    generalInstructions: [
      "Pregunte a su equipo del corazón cuánto aumento de peso debe hacer que los llame.",
      "Coma menos sal.",
      "Termine todo su antibiótico.",
      "Tome apixabán exactamente como se lo recetaron. No lo suspenda a menos que su médico se lo indique.",
      "Levántese despacio y use su ayuda para caminar para prevenir caídas.",
    ],
    warningHeading: "Busque ayuda DE INMEDIATO si tiene:",
    warningSigns: [
      "Dolor de pecho nuevo",
      "Dificultad para respirar intensa o que empeora",
      "Desmayos o casi desmayarse",
      "Latidos rápidos o irregulares que no cesan y lo hacen sentir mal",
      "Hinchazón o aumento rápido de peso",
      "Enrojecimiento que se extiende más allá del área marcada, o dolor de pierna que empeora rápido",
      "Fiebre nueva, escalofríos, confusión o sentirse muy débil",
      "Sangrado grave mientras toma su anticoagulante",
    ],
    emergencyLine: "Si parece una emergencia, llame al 911.",
    whyHospitalized: [
      "Su insuficiencia cardíaca empeoró y se acumuló líquido: unas 10 libras, con piernas hinchadas y dificultad para respirar al acostarse.",
      "Tuvo un ritmo cardíaco rápido e irregular (fibrilación auricular).",
      "Tuvo una infección de piel en su pierna derecha (celulitis).",
    ],
  },
  zh: {
    title: "您的护理计划",
    medicationsIntro: "这些是您现在应该服用的所有药物。",
    medGroups: [
      {
        items: [
          { name: "托拉塞米 20 毫克", reason: "排出多余的体液", flag: "新药" },
          { name: "琥珀酸美托洛尔 75 毫克", reason: "减慢您的心跳", flag: "新药" },
          { name: "恩格列净 10 毫克", reason: "用于您的心脏", flag: "新药" },
          { name: "头孢氨苄 500 毫克", reason: "治疗腿部感染的抗生素", flag: "新药，仅再服用 4 天" },
          { name: "阿哌沙班 5 毫克", reason: "抗凝血药" },
        ],
      },
      {
        items: [
          { name: "头孢氨苄 500 毫克", reason: "治疗腿部感染的抗生素", flag: "新药，仅再服用 4 天" },
        ],
      },
      {
        items: [
          { name: "头孢氨苄 500 毫克", reason: "治疗腿部感染的抗生素", flag: "新药，仅再服用 4 天" },
          { name: "阿哌沙班 5 毫克", reason: "抗凝血药" },
        ],
      },
      {
        items: [
          { name: "头孢氨苄 500 毫克", reason: "治疗腿部感染的抗生素", flag: "新药，仅再服用 4 天" },
          { name: "阿托伐他汀（剂量按医院清单）", reason: "用于胆固醇" },
        ],
      },
      {
        items: [
          { name: "氨氯地平", reason: "用于您的血压" },
          { name: "您常用的糖尿病药物", reason: "按照您的医院用药清单服用" },
        ],
      },
    ],
    newMedicines: [
      { name: "托拉塞米 20 毫克，每日一次", detail: "替代呋塞米。请不要再服用呋塞米。" },
      { name: "琥珀酸美托洛尔 75 毫克，每日一次", detail: "替代您以前的短效美托洛尔。不要同时服用两者。" },
      { name: "恩格列净 10 毫克，每日一次", detail: "用于您的心脏。" },
      { name: "头孢氨苄 500 毫克，每日四次，再服用 4 天", detail: "一种治疗腿部感染的抗生素。请服完每一剂直至用完。" },
    ],
    stoppedMedicines: [
      { name: "呋塞米", detail: "已停用。由托拉塞米替代——不要同时服用两者。" },
      { name: "以前的短效美托洛尔（酒石酸盐）", detail: "已停用。由琥珀酸盐剂型替代——不要同时服用两者。" },
    ],
    labs: [
      { label: "检查肾脏和电解质的血液检验", detail: "按医嘱进行。它可确认新利尿药是否安全。" },
    ],
    appointments: [
      { label: "心脏科医生（心脏病科）" },
      { label: "家庭医生（初级保健）" },
    ],
    appointmentsNote: "如果您还没有任何一个的日期，请致电诊所预约。",
    careInstructions: [
      { label: "每天早上称体重" },
      { label: "每天检查您的右腿", detail: "发红、发热和肿胀应持续好转。" },
      { label: "休息时抬高右腿" },
    ],
    generalInstructions: [
      "询问您的心脏团队，体重增加多少时应打电话给他们。",
      "少吃盐。",
      "服完所有抗生素。",
      "严格按处方服用阿哌沙班。除非医生指示，否则不要停药。",
      "缓慢起身并使用助行器以防跌倒。",
    ],
    warningHeading: "出现以下情况请立即就医：",
    warningSigns: [
      "新出现的胸痛",
      "严重或加重的呼吸困难",
      "昏厥或几乎昏厥",
      "持续的快速或不规则心跳并使您感到不适",
      "肿胀或体重快速上升",
      "发红扩散超出标记区域，或腿痛迅速加重",
      "新出现的发烧、寒战、意识混乱或非常虚弱",
      "服用抗凝血药期间严重出血",
    ],
    emergencyLine: "如果像是紧急情况，请拨打 911。",
    whyHospitalized: [
      "您的心力衰竭加重并积液——约 10 磅，伴腿部肿胀和平躺时呼吸困难。",
      "您出现快速、不规则的心跳（房颤）。",
      "您的右腿有皮肤感染（蜂窝织炎）。",
    ],
  },
  ar: {
    title: "خطة رعايتك",
    medicationsIntro: "هذه كل الأدوية التي يجب أن تتناولها الآن.",
    medGroups: [
      {
        items: [
          { name: "تورسيميد 20 ملغ", reason: "يزيل السوائل الزائدة", flag: "جديد" },
          { name: "ميتوبرولول سكسينات 75 ملغ", reason: "يبطئ نبضات قلبك", flag: "جديد" },
          { name: "إمباغليفلوزين 10 ملغ", reason: "لقلبك", flag: "جديد" },
          { name: "سيفالكسين 500 ملغ", reason: "مضاد حيوي لعدوى ساقك", flag: "جديد، لمدة 4 أيام فقط" },
          { name: "أبيكسابان 5 ملغ", reason: "مميّع للدم" },
        ],
      },
      {
        items: [
          { name: "سيفالكسين 500 ملغ", reason: "مضاد حيوي لعدوى ساقك", flag: "جديد، لمدة 4 أيام فقط" },
        ],
      },
      {
        items: [
          { name: "سيفالكسين 500 ملغ", reason: "مضاد حيوي لعدوى ساقك", flag: "جديد، لمدة 4 أيام فقط" },
          { name: "أبيكسابان 5 ملغ", reason: "مميّع للدم" },
        ],
      },
      {
        items: [
          { name: "سيفالكسين 500 ملغ", reason: "مضاد حيوي لعدوى ساقك", flag: "جديد، لمدة 4 أيام فقط" },
          { name: "أتورفاستاتين (الجرعة حسب قائمة المستشفى)", reason: "للكوليسترول" },
        ],
      },
      {
        items: [
          { name: "أملوديبين", reason: "لضغط دمك" },
          { name: "أدوية السكري المعتادة لديك", reason: "تناولها حسب قائمة أدوية المستشفى الخاصة بك" },
        ],
      },
    ],
    newMedicines: [
      { name: "تورسيميد 20 ملغ مرة واحدة يومياً", detail: "يحل محل فوروسيميد. لا تتناول فوروسيميد بعد الآن." },
      { name: "ميتوبرولول سكسينات 75 ملغ مرة واحدة يومياً", detail: "يحل محل ميتوبرولول القصير المفعول السابق. لا تتناول كليهما." },
      { name: "إمباغليفلوزين 10 ملغ مرة واحدة يومياً", detail: "لقلبك." },
      { name: "سيفالكسين 500 ملغ أربع مرات يومياً لمدة 4 أيام إضافية", detail: "مضاد حيوي لعدوى ساقك. تناول كل جرعة حتى تنتهي الكمية." },
    ],
    stoppedMedicines: [
      { name: "فوروسيميد", detail: "متوقف. التورسيميد يحل محله — لا تتناول كليهما." },
      { name: "ميتوبرولول القصير المفعول السابق (تارترات)", detail: "متوقف. صيغة السكسينات تحل محله — لا تتناول كليهما." },
    ],
    labs: [
      { label: "تحليل دم للكلى والكهارل", detail: "حسب الطلب. يتحقق من سلامة حبة الماء الجديدة." },
    ],
    appointments: [
      { label: "طبيب القلب" },
      { label: "طبيب العائلة (الرعاية الأولية)" },
    ],
    appointmentsNote: "إذا لم يكن لديك موعد لأي منها بعد، اتصل بالعيادة لتحديده.",
    careInstructions: [
      { label: "زن نفسك كل صباح" },
      { label: "افحص ساقك اليمنى كل يوم", detail: "يجب أن يستمر الاحمرار والدفء والتورم في التحسن." },
      { label: "ارفع ساقك اليمنى عند الراحة" },
    ],
    generalInstructions: [
      "اسأل فريق القلب عن مقدار زيادة الوزن الذي يستوجب الاتصال بهم.",
      "قلّل الملح.",
      "أكمل كل المضاد الحيوي.",
      "تناول أبيكسابان تماماً كما وُصف لك. لا توقفه إلا إذا أخبرك طبيبك بذلك.",
      "انهض ببطء واستخدم مساعدة المشي لتجنب السقوط.",
    ],
    warningHeading: "اطلب المساعدة فوراً عند:",
    warningSigns: [
      "ألم جديد في الصدر",
      "ضيق تنفس شديد أو يزداد سوءاً",
      "إغماء أو شعور بقرب الإغماء",
      "نبض سريع أو غير منتظم لا يتوقف ويجعلك تشعر بالتوعك",
      "تورم أو زيادة سريعة في الوزن",
      "احمرار يمتد خارج المنطقة المعلّمة، أو ألم في الساق يزداد بسرعة",
      "حمى جديدة، قشعريرة، تشوش ذهني، أو شعور بضعف شديد",
      "نزيف خطير أثناء تناول مميّع الدم",
    ],
    emergencyLine: "إذا بدا الأمر حالة طارئة، اتصل بـ 911.",
    whyHospitalized: [
      "ساءت حالة قصور القلب وتراكمت السوائل — نحو 10 أرطال، مع تورم الساقين وصعوبة التنفس عند الاستلقاء.",
      "عانيت من نبض سريع وغير منتظم (رجفان أذيني).",
      "أصبت بعدوى جلدية في ساقك اليمنى (التهاب النسيج الخلوي).",
    ],
  },
}

// Example 4 — COPD / Pneumonia / Heart Failure
const example4Text: Record<"es" | "zh" | "ar", PlanText> = {
  es: {
    title: "Su plan de atención",
    medicationsIntro: "Estos son todos los medicamentos que debe tomar ahora.",
    medGroups: [
      {
        items: [
          { name: "Furosemida 40 mg", reason: "elimina el líquido extra", flag: "NUEVO, dosis más alta hasta su visita médica" },
          { name: "Prednisona 40 mg", reason: "un esteroide para su brote de EPOC", flag: "NUEVO, solo por 2 días más" },
          { name: "Doxiciclina 100 mg", reason: "antibiótico para su infección pulmonar", flag: "NUEVO, solo por 3 días más" },
        ],
      },
      {
        items: [
          { name: "Doxiciclina 100 mg", reason: "antibiótico para su infección pulmonar", flag: "NUEVO, solo por 3 días más" },
        ],
      },
      {
        items: [
          { name: "Inhalador de mantenimiento diario", reason: "úselo todos los días" },
          { name: "Carvedilol", reason: "para su corazón" },
          { name: "Sus otros medicamentos habituales", reason: "tómelos según su lista de medicamentos del hospital" },
        ],
      },
      {
        items: [
          { name: "Inhalador de rescate de albuterol", reason: "para la falta de aire repentina" },
        ],
      },
    ],
    newMedicines: [
      { name: "Furosemida 40 mg una vez al día", detail: "Esta es una dosis MÁS ALTA. Tómela hasta su visita médica y luego pregunte qué hacer." },
      { name: "Prednisona 40 mg una vez al día por 2 días más", detail: "Un esteroide para su brote de EPOC. Luego suspéndala." },
      { name: "Doxiciclina 100 mg dos veces al día por 3 días más", detail: "Un antibiótico. Tome cada dosis hasta terminarlo." },
    ],
    stoppedMedicines: [
      { name: "Su furosemida anterior de dosis más baja", detail: "No la tome por ahora. Tome solo la dosis de 40 mg hasta que le indiquen lo contrario." },
    ],
    labs: [],
    appointments: [
      { label: "Médico de cabecera (atención primaria)" },
      { label: "Neumólogo (médico del pulmón)" },
      { label: "Cardiólogo (médico del corazón)" },
    ],
    appointmentsNote: "Si aún no tiene fecha para alguna de estas citas, llame al consultorio para programarla.",
    careInstructions: [
      { label: "Pésese cada mañana" },
      { label: "Use su oxígeno al flujo y en los horarios indicados", detail: "Úselo con la actividad y al dormir según lo ordenado." },
    ],
    generalInstructions: [
      "Use su inhalador diario todos los días. Use el inhalador de rescate solo para la falta de aire repentina.",
      "Termine toda su prednisona y su antibiótico.",
      "Pregunte a su equipo del corazón cuánto aumento de peso debe hacer que los llame.",
      "Coma menos sal.",
      "Deje de fumar: pida ayuda para dejarlo.",
      "Nunca fume cerca del oxígeno y manténgalo lejos de las llamas.",
    ],
    warningHeading: "Llame al 911 o vaya a la sala de emergencias si tiene:",
    warningSigns: [
      "Falta de aire intensa que no mejora con su inhalador de rescate",
      "Dolor de pecho nuevo o peor",
      "Labios azules o grises, o estar demasiado sin aire para hablar",
      "Confusión nueva o no poder mantenerse despierto",
      "Necesitar mucho más oxígeno de lo habitual",
      "Fiebre alta, o tos con flema que empeora rápido",
      "Aumento rápido de peso con más hinchazón o dificultad para respirar al acostarse",
    ],
    emergencyLine: "Si parece una emergencia, llame al 911.",
    whyHospitalized: [
      "Su EPOC tuvo un brote y su oxígeno en sangre estuvo bajo.",
      "Tuvo neumonía (una infección pulmonar).",
      "Su insuficiencia cardíaca empeoró con líquido extra.",
    ],
  },
  zh: {
    title: "您的护理计划",
    medicationsIntro: "这些是您现在应该服用的所有药物。",
    medGroups: [
      {
        items: [
          { name: "呋塞米 40 毫克", reason: "排出多余的体液", flag: "新药，加大剂量直到就诊" },
          { name: "泼尼松 40 毫克", reason: "治疗慢阻肺急性发作的类固醇", flag: "新药，仅再服用 2 天" },
          { name: "多西环素 100 毫克", reason: "治疗肺部感染的抗生素", flag: "新药，仅再服用 3 天" },
        ],
      },
      {
        items: [
          { name: "多西环素 100 毫克", reason: "治疗肺部感染的抗生素", flag: "新药，仅再服用 3 天" },
        ],
      },
      {
        items: [
          { name: "每日维持吸入剂", reason: "每天使用" },
          { name: "卡维地洛", reason: "用于您的心脏" },
          { name: "您其他常用的药物", reason: "按照您的医院用药清单服用" },
        ],
      },
      {
        items: [
          { name: "沙丁胺醇急救吸入剂", reason: "用于突发的呼吸困难" },
        ],
      },
    ],
    newMedicines: [
      { name: "呋塞米 40 毫克，每日一次", detail: "这是更高的剂量。服用到就诊时，然后询问下一步怎么做。" },
      { name: "泼尼松 40 毫克，每日一次，再服用 2 天", detail: "治疗慢阻肺急性发作的类固醇。之后停药。" },
      { name: "多西环素 100 毫克，每日两次，再服用 3 天", detail: "一种抗生素。请服完每一剂直至用完。" },
    ],
    stoppedMedicines: [
      { name: "您以前较低剂量的呋塞米", detail: "目前请勿服用。在另有指示前只服用 40 毫克剂量。" },
    ],
    labs: [],
    appointments: [
      { label: "家庭医生（初级保健）" },
      { label: "肺科医生（呼吸科）" },
      { label: "心脏科医生（心脏病科）" },
    ],
    appointmentsNote: "如果您还没有任何一个的日期，请致电诊所预约。",
    careInstructions: [
      { label: "每天早上称体重" },
      { label: "按处方的流量和时间使用氧气", detail: "按医嘱在活动和睡眠时使用。" },
    ],
    generalInstructions: [
      "每天使用您的每日吸入剂。仅在突发呼吸困难时使用急救吸入剂。",
      "服完所有泼尼松和抗生素。",
      "询问您的心脏团队，体重增加多少时应打电话给他们。",
      "少吃盐。",
      "戒烟——寻求戒烟帮助。",
      "切勿在氧气附近吸烟，并使其远离火焰。",
    ],
    warningHeading: "出现以下情况请拨打 911 或前往急诊室：",
    warningSigns: [
      "使用急救吸入剂后仍不缓解的严重呼吸困难",
      "新出现或加重的胸痛",
      "嘴唇发青或发灰，或气促到无法说话",
      "新出现的意识混乱或无法保持清醒",
      "需要比平时多得多的氧气",
      "高烧，或咳带痰迅速加重",
      "体重快速上升伴更多肿胀或平躺时呼吸困难",
    ],
    emergencyLine: "如果像是紧急情况，请拨打 911。",
    whyHospitalized: [
      "您的慢阻肺急性发作，血氧偏低。",
      "您患了肺炎（肺部感染）。",
      "您的心力衰竭加重并有额外积液。",
    ],
  },
  ar: {
    title: "خطة رعايتك",
    medicationsIntro: "هذه كل الأدوية التي يجب أن تتناولها الآن.",
    medGroups: [
      {
        items: [
          { name: "فوروسيميد 40 ملغ", reason: "يزيل السوائل الزائدة", flag: "جديد، جرعة أعلى حتى زيارة الطبيب" },
          { name: "بريدنيزون 40 ملغ", reason: "ستيرويد لنوبة الانسداد الرئوي لديك", flag: "جديد، لمدة يومين فقط" },
          { name: "دوكسيسيكلين 100 ملغ", reason: "مضاد حيوي لعدوى الرئة لديك", flag: "جديد، لمدة 3 أيام فقط" },
        ],
      },
      {
        items: [
          { name: "دوكسيسيكلين 100 ملغ", reason: "مضاد حيوي لعدوى الرئة لديك", flag: "جديد، لمدة 3 أيام فقط" },
        ],
      },
      {
        items: [
          { name: "جهاز استنشاق الصيانة اليومي", reason: "استخدمه كل يوم" },
          { name: "كارفيديلول", reason: "لقلبك" },
          { name: "أدويتك المعتادة الأخرى", reason: "تناولها حسب قائمة أدوية المستشفى الخاصة بك" },
        ],
      },
      {
        items: [
          { name: "جهاز استنشاق الإنقاذ ألبوتيرول", reason: "لضيق التنفس المفاجئ" },
        ],
      },
    ],
    newMedicines: [
      { name: "فوروسيميد 40 ملغ مرة واحدة يومياً", detail: "هذه جرعة أعلى. تناولها حتى زيارة الطبيب، ثم اسأل عما يجب فعله." },
      { name: "بريدنيزون 40 ملغ مرة واحدة يومياً لمدة يومين إضافيين", detail: "ستيرويد لنوبة الانسداد الرئوي. ثم أوقفه." },
      { name: "دوكسيسيكلين 100 ملغ مرتين يومياً لمدة 3 أيام إضافية", detail: "مضاد حيوي. تناول كل جرعة حتى تنتهي الكمية." },
    ],
    stoppedMedicines: [
      { name: "فوروسيميد السابق بالجرعة الأقل", detail: "لا تتناوله الآن. تناول جرعة 40 ملغ فقط حتى يُقال لك خلاف ذلك." },
    ],
    labs: [],
    appointments: [
      { label: "طبيب العائلة (الرعاية الأولية)" },
      { label: "طبيب الرئة" },
      { label: "طبيب القلب" },
    ],
    appointmentsNote: "إذا لم يكن لديك موعد لأي منها بعد، اتصل بالعيادة لتحديده.",
    careInstructions: [
      { label: "زن نفسك كل صباح" },
      { label: "استخدم الأكسجين بالتدفق والأوقات الموصوفة", detail: "استخدمه مع النشاط والنوم حسب الطلب." },
    ],
    generalInstructions: [
      "استخدم جهاز الاستنشاق اليومي كل يوم. استخدم جهاز الإنقاذ فقط لضيق التنفس المفاجئ.",
      "أكمل كل البريدنيزون والمضاد الحيوي.",
      "اسأل فريق القلب عن مقدار زيادة الوزن الذي يستوجب الاتصال بهم.",
      "قلّل الملح.",
      "أقلع عن التدخين — اطلب المساعدة للإقلاع.",
      "لا تدخّن أبداً قرب الأكسجين وأبقِه بعيداً عن اللهب.",
    ],
    warningHeading: "اتصل بـ 911 أو اذهب إلى الطوارئ عند:",
    warningSigns: [
      "ضيق تنفس شديد لا يتحسن مع جهاز الإنقاذ",
      "ألم جديد أو أسوأ في الصدر",
      "شفاه زرقاء أو رمادية، أو ضيق نفس يمنعك من الكلام",
      "تشوش ذهني جديد أو عدم القدرة على البقاء مستيقظاً",
      "الحاجة إلى أكسجين أكثر بكثير من المعتاد",
      "حمى عالية، أو سعال مع بلغم يزداد سوءاً بسرعة",
      "زيادة سريعة في الوزن مع مزيد من التورم أو صعوبة التنفس عند الاستلقاء",
    ],
    emergencyLine: "إذا بدا الأمر حالة طارئة، اتصل بـ 911.",
    whyHospitalized: [
      "اشتعلت نوبة الانسداد الرئوي لديك وكان أكسجين دمك منخفضاً.",
      "أصبت بالتهاب رئوي (عدوى في الرئة).",
      "ساءت حالة قصور القلب لديك مع سوائل إضافية.",
    ],
  },
}

// Example 5 — Endocarditis / Heart Failure / IV Antibiotics
const example5Text: Record<"es" | "zh" | "ar", PlanText> = {
  es: {
    title: "Su plan de atención",
    medicationsIntro: "Estos son todos los medicamentos que debe tomar ahora.",
    medGroups: [
      {
        items: [
          { name: "Furosemida 40 mg", reason: "elimina el líquido extra", flag: "NUEVO" },
          { name: "Losartán 25 mg", reason: "para su corazón", flag: "NUEVO" },
        ],
      },
      {
        items: [
          { name: "Cefazolina por su vía IV", reason: "para la infección de su válvula cardíaca", flag: "NUEVO, según el horario que fijen su médico de infecciones y el equipo de IV" },
        ],
      },
      {
        items: [
          { name: "Metoprolol succinato", reason: "para su corazón" },
          { name: "Sus otros medicamentos habituales", reason: "tómelos según su lista de medicamentos del hospital" },
        ],
      },
    ],
    newMedicines: [
      { name: "Cefazolina por su vía IV", detail: "Un antibiótico para la infección de su válvula cardíaca. Su médico de infecciones fijó la dosis y el horario. Tome cada dosis hasta terminar todo el ciclo: no lo suspenda ni lo cambie por su cuenta." },
      { name: "Furosemida 40 mg una vez al día", detail: "Una pastilla de agua: hará que orine más." },
      { name: "Losartán 25 mg una vez al día", detail: "Una dosis inicial baja para su corazón." },
    ],
    stoppedMedicines: [
      { name: "AINE (ibuprofeno, naproxeno)", detail: "No los tome a menos que su médico diga que está bien." },
    ],
    labs: [
      { label: "Análisis de sangre", detail: "Según lo programe su programa de antibióticos IV." },
    ],
    appointments: [
      { label: "Médico de infecciones (enfermedades infecciosas)" },
      { label: "Cardiólogo (médico del corazón)" },
      { label: "Visitas de antibiótico IV (infusión)" },
      { label: "Visitas de cuidado de la vía IV (PICC)" },
    ],
    appointmentsNote: "Si aún no tiene fecha para alguna de estas citas, llame al consultorio para programarla.",
    careInstructions: [
      { label: "Pésese cada mañana y anote el peso" },
      { label: "Cuide su vía IV (PICC) como le mostró su enfermera" },
    ],
    generalInstructions: [
      "Termine todo el ciclo de antibiótico IV. No lo suspenda ni lo cambie por su cuenta.",
      "Tenga a la mano el número de teléfono de su equipo de IV.",
      "Pregunte a su equipo del corazón cuánto aumento de peso debe hacer que los llame.",
      "Coma menos sal y siga su plan de líquidos.",
      "Siga sus límites de actividad.",
      "Siga el consejo de su médico antes de cualquier trabajo dental o procedimiento.",
      "No tome AINE (ibuprofeno, naproxeno).",
    ],
    warningHeading: "Busque ayuda DE INMEDIATO si tiene:",
    warningSigns: [
      "Fiebre, escalofríos o sentirse enfermo de nuevo",
      "Falta de aire nueva o peor",
      "Dolor de pecho",
      "Desmayos o mareos intensos",
      "Debilidad, cara caída, dificultad para hablar o confusión",
      "Hinchazón o aumento rápido de peso",
      "Sangrado, líquido o enrojecimiento alrededor de su vía IV",
      "Dolor intenso y repentino en la espalda, el pecho o el abdomen",
      "Cualquier problema con su vía IV",
    ],
    emergencyLine: "Si parece una emergencia, llame al 911.",
    whyHospitalized: [
      "Tuvo una infección en una válvula cardíaca (la válvula mitral) por bacterias estafilococo en su sangre.",
      "La válvula tuvo una fuga y su insuficiencia cardíaca empeoró, con líquido en los pulmones.",
      "Necesita un ciclo largo de antibióticos IV para eliminar la infección.",
    ],
  },
  zh: {
    title: "您的护理计划",
    medicationsIntro: "这些是您现在应该服用的所有药物。",
    medGroups: [
      {
        items: [
          { name: "呋塞米 40 毫克", reason: "排出多余的体液", flag: "新药" },
          { name: "氯沙坦 25 毫克", reason: "用于您的心脏", flag: "新药" },
        ],
      },
      {
        items: [
          { name: "通过静脉管路的头孢唑林", reason: "用于您的心脏瓣膜感染", flag: "新药，按您的感染科医生和静脉团队设定的时间表" },
        ],
      },
      {
        items: [
          { name: "琥珀酸美托洛尔", reason: "用于您的心脏" },
          { name: "您其他常用的药物", reason: "按照您的医院用药清单服用" },
        ],
      },
    ],
    newMedicines: [
      { name: "通过静脉管路的头孢唑林", detail: "治疗心脏瓣膜感染的抗生素。您的感染科医生已设定剂量和时间表。请服完整个疗程的每一剂——不要自行停药或更改。" },
      { name: "呋塞米 40 毫克，每日一次", detail: "一种利尿药——会让您排尿增多。" },
      { name: "氯沙坦 25 毫克，每日一次", detail: "用于您心脏的低起始剂量。" },
    ],
    stoppedMedicines: [
      { name: "非甾体抗炎药（布洛芬、萘普生）", detail: "除非医生说可以，否则请勿服用。" },
    ],
    labs: [
      { label: "血液检查", detail: "按您的静脉抗生素计划安排。" },
    ],
    appointments: [
      { label: "感染科医生（传染病科）" },
      { label: "心脏科医生（心脏病科）" },
      { label: "静脉抗生素（输注）就诊" },
      { label: "静脉管路（PICC）护理就诊" },
    ],
    appointmentsNote: "如果您还没有任何一个的日期，请致电诊所预约。",
    careInstructions: [
      { label: "每天早上称体重并记录下来" },
      { label: "按护士教您的方式护理静脉管路（PICC）" },
    ],
    generalInstructions: [
      "完成整个静脉抗生素疗程。不要自行停药或更改。",
      "随手保留您静脉团队的电话号码。",
      "询问您的心脏团队，体重增加多少时应打电话给他们。",
      "少吃盐并遵循您的液体计划。",
      "遵守您的活动限制。",
      "在任何牙科治疗或操作前遵循医生的建议。",
      "不要服用非甾体抗炎药（布洛芬、萘普生）。",
    ],
    warningHeading: "出现以下情况请立即就医：",
    warningSigns: [
      "再次发烧、寒战或感到不适",
      "新出现或加重的呼吸困难",
      "胸痛",
      "昏厥或严重头晕",
      "虚弱、面部下垂、言语困难或意识混乱",
      "肿胀或体重快速上升",
      "静脉管路周围出血、渗液或发红",
      "背部、胸部或腹部突发剧痛",
      "静脉管路出现任何问题",
    ],
    emergencyLine: "如果像是紧急情况，请拨打 911。",
    whyHospitalized: [
      "您的心脏瓣膜（二尖瓣）因血液中的葡萄球菌而发生感染。",
      "瓣膜出现渗漏，心力衰竭加重，肺部积液。",
      "您需要长疗程的静脉抗生素来清除感染。",
    ],
  },
  ar: {
    title: "خطة رعايتك",
    medicationsIntro: "هذه كل الأدوية التي يجب أن تتناولها الآن.",
    medGroups: [
      {
        items: [
          { name: "فوروسيميد 40 ملغ", reason: "يزيل السوائل الزائدة", flag: "جديد" },
          { name: "لوسارتان 25 ملغ", reason: "لقلبك", flag: "جديد" },
        ],
      },
      {
        items: [
          { name: "سيفازولين عبر الخط الوريدي", reason: "لعدوى صمام قلبك", flag: "جديد، حسب الجدول الذي يحدده طبيب العدوى وفريق الوريد" },
        ],
      },
      {
        items: [
          { name: "ميتوبرولول سكسينات", reason: "لقلبك" },
          { name: "أدويتك المعتادة الأخرى", reason: "تناولها حسب قائمة أدوية المستشفى الخاصة بك" },
        ],
      },
    ],
    newMedicines: [
      { name: "سيفازولين عبر الخط الوريدي", detail: "مضاد حيوي لعدوى صمام قلبك. حدد طبيب العدوى الجرعة والجدول. تناول كل جرعة حتى يكتمل الدورة كاملة — لا توقفه أو تغيّره من تلقاء نفسك." },
      { name: "فوروسيميد 40 ملغ مرة واحدة يومياً", detail: "حبة مدرّة للبول — ستجعلك تتبول أكثر." },
      { name: "لوسارتان 25 ملغ مرة واحدة يومياً", detail: "جرعة بدء منخفضة لقلبك." },
    ],
    stoppedMedicines: [
      { name: "مضادات الالتهاب (إيبوبروفين، نابروكسين)", detail: "لا تتناولها إلا إذا قال طبيبك إنها مناسبة." },
    ],
    labs: [
      { label: "تحاليل دم", detail: "حسب جدول برنامج المضاد الحيوي الوريدي." },
    ],
    appointments: [
      { label: "طبيب العدوى (الأمراض المعدية)" },
      { label: "طبيب القلب" },
      { label: "زيارات المضاد الحيوي الوريدي (التسريب)" },
      { label: "زيارات العناية بالخط الوريدي (PICC)" },
    ],
    appointmentsNote: "إذا لم يكن لديك موعد لأي منها بعد، اتصل بالعيادة لتحديده.",
    careInstructions: [
      { label: "زن نفسك كل صباح ودوّن الوزن" },
      { label: "اعتنِ بخطك الوريدي (PICC) كما أرتك ممرضتك" },
    ],
    generalInstructions: [
      "أكمل دورة المضاد الحيوي الوريدي بالكامل. لا توقفها أو تغيّرها من تلقاء نفسك.",
      "احتفظ برقم هاتف فريق الوريد قريباً منك.",
      "اسأل فريق القلب عن مقدار زيادة الوزن الذي يستوجب الاتصال بهم.",
      "قلّل الملح واتبع خطة السوائل الخاصة بك.",
      "التزم بحدود نشاطك.",
      "اتبع نصيحة طبيبك قبل أي عمل أو إجراء في الأسنان.",
      "لا تتناول مضادات الالتهاب (إيبوبروفين، نابروكسين).",
    ],
    warningHeading: "اطلب المساعدة فوراً عند:",
    warningSigns: [
      "حمى، قشعريرة، أو الشعور بالمرض مجدداً",
      "ضيق تنفس جديد أو أسوأ",
      "ألم في الصدر",
      "إغماء أو دوخة شديدة",
      "ضعف، تدلي الوجه، صعوبة في الكلام، أو تشوش ذهني",
      "تورم أو زيادة سريعة في الوزن",
      "نزيف أو سائل أو احمرار حول خطك الوريدي",
      "ألم شديد مفاجئ في الظهر أو الصدر أو البطن",
      "أي مشكلة في خطك الوريدي",
    ],
    emergencyLine: "إذا بدا الأمر حالة طارئة، اتصل بـ 911.",
    whyHospitalized: [
      "أصبت بعدوى في صمام القلب (الصمام التاجي) بسبب بكتيريا المكورات العنقودية في دمك.",
      "تسرّب الصمام وساءت حالة قصور القلب، مع سوائل في رئتيك.",
      "تحتاج إلى دورة طويلة من المضادات الحيوية الوريدية للقضاء على العدوى.",
    ],
  },
}

// Build a complete per-language bundle from the English plan + its text table.
function byLang(
  en: DischargePlan,
  text: Record<"es" | "zh" | "ar", PlanText>,
): DischargePlanByLang {
  return {
    en,
    es: translatePlan("es", en, text.es),
    zh: translatePlan("zh", en, text.zh),
    ar: translatePlan("ar", en, text.ar),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

// Mock discharge records keyed by patient id. Each record carries a createdAt
// (seeded a small per-patient offset into the past so the 30-day countdown
// reads ~28–30 days) and the fully populated per-language plan bundle.
//
// TODO: replace with real backend call — GET /p/:token returns the authored
// DischargePlan keyed by language plus expiresAt for the authenticated patient.
export const mockDischargeByPatient: Record<string, DischargeRecord> = {
  // Elena Martinez — HFrEF / Pneumonia / AKI
  p1: { createdAt: Date.now() - 0 * DAY_MS, byLang: byLang(example1En, example1Text) },
  // James Carter — Sepsis / Complicated UTI / Ureteral Stent
  p2: { createdAt: Date.now() - 1 * DAY_MS, byLang: byLang(example2En, example2Text) },
  // Priya Nair — HFpEF / AFib / Cellulitis
  p3: { createdAt: Date.now() - 1 * DAY_MS, byLang: byLang(example3En, example3Text) },
  // Robert Chen — COPD / Pneumonia / Heart Failure
  p4: { createdAt: Date.now() - 2 * DAY_MS, byLang: byLang(example4En, example4Text) },
  // Aisha Johnson — Endocarditis / Heart Failure / IV Antibiotics
  p5: { createdAt: Date.now() - 2 * DAY_MS, byLang: byLang(example5En, example5Text) },
}
