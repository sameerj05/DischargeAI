// UI-chrome string dictionary for the patient / caregiver views.
//
// This fixes the half-translated state: section headings and other fixed
// interface labels were hardcoded English in the views, so a non-English plan
// showed English chrome around translated clinical content. Every fixed label
// now flows through t(lang, key) so chrome translates together with the plan.
//
// The clinical content (drug names, instructions, warning signs) lives in
// data.ts, fully populated per language. This module is ONLY the surrounding
// interface text.

import { type Language } from "./data"

export type UIKey =
  // Patient intro + shell chrome
  | "patientLede"
  | "signOut"
  | "privacyNotice"
  | "planUnavailable"
  // Language picker
  | "languageLabel"
  | "languageSearchPlaceholder"
  | "languageNoMatches"
  // Font-size control
  | "fontSizeLabel"
  | "fontSizeNormal"
  | "fontSizeLarge"
  | "fontSizeExtraLarge"
  | "fontDecrease"
  | "fontIncrease"
  // Deletion countdown
  | "deletionCountdown"
  | "deletionCountdownOneDay"
  | "deletionCountdownToday"
  // Section headings
  | "medicationsTitle"
  | "newMedicinesTitle"
  | "stoppedMedicinesTitle"
  | "todosTitle"
  | "labsTitle"
  | "appointmentsTitle"
  | "careInstructionsTitle"
  | "generalInstructionsTitle"
  | "whyHospitalizedTitle"
  // Section body chrome
  | "labsEmpty"
  | "progressComplete"
  // Caregiver chrome
  | "caregiverEyebrow"
  | "caregiverLede"
  | "caregiverNoPatient"
  | "caregiverPlanFallback"
  | "caregiverMedicationsTitle"
  | "caregiverTodosTitle"
  | "caregiverCareInstructionsTitle"

export const UI_STRINGS: Record<Language, Record<UIKey, string>> = {
  en: {
    patientLede:
      "Everything you need to recover safely at home. Check things off as you go.",
    signOut: "Sign out",
    privacyNotice: "Protected health information. Authorized access only.",
    planUnavailable: "Your plan is not available right now.",
    languageLabel: "Language",
    languageSearchPlaceholder: "Search languages",
    languageNoMatches: "No languages match your search.",
    fontSizeLabel: "Text size",
    fontSizeNormal: "Normal",
    fontSizeLarge: "Large",
    fontSizeExtraLarge: "Extra large",
    fontDecrease: "Smaller text",
    fontIncrease: "Larger text",
    deletionCountdown: "This record will be securely deleted in {days} days.",
    deletionCountdownOneDay: "This record will be securely deleted in 1 day.",
    deletionCountdownToday: "This record will be securely deleted today.",
    medicationsTitle: "Your medications",
    newMedicinesTitle: "New medicines",
    stoppedMedicinesTitle: "Medicines to stop or hold",
    todosTitle: "Things for you to do",
    labsTitle: "Labs",
    appointmentsTitle: "Appointments",
    careInstructionsTitle: "Instructions for your care",
    generalInstructionsTitle: "General instructions",
    whyHospitalizedTitle: "Why you were in the hospital",
    labsEmpty: "No blood tests were listed in your plan.",
    progressComplete: "{done} of {total} complete",
    caregiverEyebrow: "Caregiver view",
    caregiverLede:
      "Review the going-home plan and track what's done on your patient's behalf.",
    caregiverNoPatient: "No linked patient plan is available.",
    caregiverPlanFallback: "Care plan for your linked patient",
    caregiverMedicationsTitle: "Medications",
    caregiverTodosTitle: "Things to do",
    caregiverCareInstructionsTitle: "Instructions for care",
  },
  es: {
    patientLede:
      "Todo lo que necesita para recuperarse de forma segura en casa. Marque las tareas a medida que avanza.",
    signOut: "Cerrar sesión",
    privacyNotice: "Información médica protegida. Solo acceso autorizado.",
    planUnavailable: "Su plan no está disponible en este momento.",
    languageLabel: "Idioma",
    languageSearchPlaceholder: "Buscar idiomas",
    languageNoMatches: "Ningún idioma coincide con su búsqueda.",
    fontSizeLabel: "Tamaño del texto",
    fontSizeNormal: "Normal",
    fontSizeLarge: "Grande",
    fontSizeExtraLarge: "Muy grande",
    fontDecrease: "Texto más pequeño",
    fontIncrease: "Texto más grande",
    deletionCountdown:
      "Este registro se eliminará de forma segura en {days} días.",
    deletionCountdownOneDay:
      "Este registro se eliminará de forma segura en 1 día.",
    deletionCountdownToday: "Este registro se eliminará de forma segura hoy.",
    medicationsTitle: "Sus medicamentos",
    newMedicinesTitle: "Medicamentos nuevos",
    stoppedMedicinesTitle: "Medicamentos para suspender o pausar",
    todosTitle: "Cosas que debe hacer",
    labsTitle: "Análisis",
    appointmentsTitle: "Citas",
    careInstructionsTitle: "Instrucciones para su cuidado",
    generalInstructionsTitle: "Instrucciones generales",
    whyHospitalizedTitle: "Por qué estuvo en el hospital",
    labsEmpty: "No se indicaron análisis de sangre en su plan.",
    progressComplete: "{done} de {total} completado",
    caregiverEyebrow: "Vista del cuidador",
    caregiverLede:
      "Revise el plan de regreso a casa y controle lo que está hecho en nombre de su paciente.",
    caregiverNoPatient: "No hay ningún plan de paciente vinculado disponible.",
    caregiverPlanFallback: "Plan de atención para su paciente vinculado",
    caregiverMedicationsTitle: "Medicamentos",
    caregiverTodosTitle: "Cosas por hacer",
    caregiverCareInstructionsTitle: "Instrucciones de cuidado",
  },
  zh: {
    patientLede: "在家安全康复所需的一切。完成后请逐项打勾。",
    signOut: "退出登录",
    privacyNotice: "受保护的健康信息。仅限授权访问。",
    planUnavailable: "您的计划目前无法使用。",
    languageLabel: "语言",
    languageSearchPlaceholder: "搜索语言",
    languageNoMatches: "没有符合您搜索的语言。",
    fontSizeLabel: "文字大小",
    fontSizeNormal: "正常",
    fontSizeLarge: "大",
    fontSizeExtraLarge: "特大",
    fontDecrease: "缩小文字",
    fontIncrease: "放大文字",
    deletionCountdown: "此记录将在 {days} 天后被安全删除。",
    deletionCountdownOneDay: "此记录将在 1 天后被安全删除。",
    deletionCountdownToday: "此记录将于今天被安全删除。",
    medicationsTitle: "您的药物",
    newMedicinesTitle: "新药物",
    stoppedMedicinesTitle: "需要停用或暂停的药物",
    todosTitle: "您需要做的事",
    labsTitle: "化验",
    appointmentsTitle: "预约",
    careInstructionsTitle: "护理说明",
    generalInstructionsTitle: "一般说明",
    whyHospitalizedTitle: "您为何住院",
    labsEmpty: "您的计划中未列出血液检查。",
    progressComplete: "已完成 {done}/{total}",
    caregiverEyebrow: "照护者视图",
    caregiverLede: "查看回家计划，并代表您的患者跟踪已完成的事项。",
    caregiverNoPatient: "没有可用的关联患者计划。",
    caregiverPlanFallback: "您关联患者的护理计划",
    caregiverMedicationsTitle: "药物",
    caregiverTodosTitle: "待办事项",
    caregiverCareInstructionsTitle: "护理说明",
  },
  ar: {
    patientLede:
      "كل ما تحتاجه للتعافي بأمان في المنزل. ضع علامة على المهام أثناء تقدمك.",
    signOut: "تسجيل الخروج",
    privacyNotice: "معلومات صحية محمية. الوصول للمصرح لهم فقط.",
    planUnavailable: "خطتك غير متوفرة في الوقت الحالي.",
    languageLabel: "اللغة",
    languageSearchPlaceholder: "ابحث عن اللغات",
    languageNoMatches: "لا توجد لغات تطابق بحثك.",
    fontSizeLabel: "حجم النص",
    fontSizeNormal: "عادي",
    fontSizeLarge: "كبير",
    fontSizeExtraLarge: "كبير جداً",
    fontDecrease: "نص أصغر",
    fontIncrease: "نص أكبر",
    deletionCountdown: "سيتم حذف هذا السجل بشكل آمن خلال {days} يوماً.",
    deletionCountdownOneDay: "سيتم حذف هذا السجل بشكل آمن خلال يوم واحد.",
    deletionCountdownToday: "سيتم حذف هذا السجل بشكل آمن اليوم.",
    medicationsTitle: "أدويتك",
    newMedicinesTitle: "أدوية جديدة",
    stoppedMedicinesTitle: "أدوية يجب إيقافها أو تعليقها",
    todosTitle: "أشياء يجب أن تقوم بها",
    labsTitle: "التحاليل",
    appointmentsTitle: "المواعيد",
    careInstructionsTitle: "تعليمات العناية بك",
    generalInstructionsTitle: "تعليمات عامة",
    whyHospitalizedTitle: "لماذا كنت في المستشفى",
    labsEmpty: "لم تُدرج أي فحوصات دم في خطتك.",
    progressComplete: "{done} من {total} مكتمل",
    caregiverEyebrow: "عرض مقدم الرعاية",
    caregiverLede: "راجع خطة العودة إلى المنزل وتابع ما تم إنجازه نيابة عن مريضك.",
    caregiverNoPatient: "لا توجد خطة مريض مرتبطة متاحة.",
    caregiverPlanFallback: "خطة الرعاية لمريضك المرتبط",
    caregiverMedicationsTitle: "الأدوية",
    caregiverTodosTitle: "أشياء يجب القيام بها",
    caregiverCareInstructionsTitle: "تعليمات الرعاية",
  },
}

// Simple {token} interpolation. Replaces every {name} in the string with
// params[name]; leaves unknown tokens in place.
export function t(
  lang: Language,
  key: UIKey,
  params?: Record<string, string | number>,
): string {
  const template = UI_STRINGS[lang][key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = params[token]
    return value === undefined ? match : String(value)
  })
}

// Days remaining until the 30-day secure deletion. Day precision is enough.
//
// TODO: use the real expiresAt from GET /p/:token instead of createdAt + 30d.
export function daysUntilDeletion(createdAt: number): number {
  const dayMs = 24 * 60 * 60 * 1000
  const expiresAt = createdAt + 30 * dayMs
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / dayMs))
}
