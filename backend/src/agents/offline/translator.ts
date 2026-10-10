import type { TranslateInput, TranslateResult, TranslatorAgent } from "../translator.js";
import type { SimplifiedSummary } from "../types.js";
import { FIXTURE_MANIFEST, loadSimplifiedFixture, loadTranslationFixture } from "./fixtures.js";

/**
 * Offline translator: the curated Spanish fixture for Example 1, a phrase dictionary for Spanish on
 * anything else, and a marked passthrough for other languages. Medication names and doses are never
 * touched. The back-translation it reports is the original, so the backend's diff check is a no-op here.
 */
export class OfflineTranslator implements TranslatorAgent {
  readonly name = "offline";

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const t0 = Date.now();
    const fixtureId = findFixtureId(input.summary);
    if (fixtureId) {
      const fixture = loadTranslationFixture(fixtureId, input.language);
      if (fixture) {
        return {
          translation: fixture,
          backTranslation: structuredClone(input.summary),
          provider: this.name,
          model: `fixture:${fixtureId}.${input.language}`,
          fixture: `${fixtureId}.${input.language}`,
          latencyMs: Date.now() - t0,
        };
      }
    }
    if (input.language === "es") {
      return {
        translation: mapStrings(input.summary, (s) => spanishPhrases(s), input.language),
        backTranslation: structuredClone(input.summary),
        provider: this.name,
        model: "dictionary:es",
        latencyMs: Date.now() - t0,
      };
    }
    if (input.language === "en") {
      return { translation: structuredClone(input.summary), backTranslation: structuredClone(input.summary), provider: this.name, model: "identity", latencyMs: Date.now() - t0 };
    }
    return {
      translation: mapStrings(input.summary, (s) => `[${input.language}] ${s}`, input.language),
      backTranslation: structuredClone(input.summary),
      provider: this.name,
      model: "passthrough",
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * A summary gets the curated translation only when it IS the fixture, field for field. Anything
 * edited after simplification (a safety notice, a teammate's prompt change) goes through the
 * dictionary path so nothing added in English is silently dropped from the translation.
 */
function findFixtureId(summary: SimplifiedSummary): string | undefined {
  const wanted = JSON.stringify(summary);
  for (const f of FIXTURE_MANIFEST) {
    try {
      if (JSON.stringify(loadSimplifiedFixture(f.id)) === wanted) return f.id;
    } catch {
      /* fixture missing */
    }
  }
  return undefined;
}

/** Applies fn to every patient-facing string, leaving ids, types and medication name/dose alone. */
export function mapStrings(summary: SimplifiedSummary, fn: (s: string) => string, language: string): SimplifiedSummary {
  const med = (m: SimplifiedSummary["medications"]["new"][number]) => ({
    ...m,
    howOften: fn(m.howOften),
    why: fn(m.why),
    ...(m.startDate ? { startDate: fn(m.startDate) } : {}),
  });
  return {
    readingLevel: "grade5",
    language,
    summary: fn(summary.summary),
    diagnoses: summary.diagnoses.map((d) => ({ plain: fn(d.plain), clinical: d.clinical })),
    medications: {
      new: summary.medications.new.map(med),
      continue: summary.medications.continue.map(med),
      stop: summary.medications.stop.map((m) => ({ name: m.name, why: fn(m.why) })),
    },
    checklist: summary.checklist.map((c) => ({ ...c, text: fn(c.text), ...(c.due ? { due: fn(c.due) } : {}) })),
    returnPrecautions: {
      call911: summary.returnPrecautions.call911.map(fn),
      goToER: summary.returnPrecautions.goToER.map(fn),
      callClinic: summary.returnPrecautions.callClinic.map(fn),
    },
    followUps: summary.followUps.map((f) => ({ who: fn(f.who), when: fn(f.when), why: fn(f.why) })),
    questionsToAsk: summary.questionsToAsk.map(fn),
  };
}

const ES: [RegExp, string][] = [
  [/\bonce a day by mouth\b/gi, "una vez al día por la boca"],
  [/\btwice a day by mouth\b/gi, "dos veces al día por la boca"],
  [/\bfour times a day\b/gi, "cuatro veces al día"],
  [/\bthree times a day\b/gi, "tres veces al día"],
  [/\btwice a day\b/gi, "dos veces al día"],
  [/\bonce a day\b/gi, "una vez al día"],
  [/\bevery night\b/gi, "cada noche"],
  [/\bevery morning\b/gi, "cada mañana"],
  [/\bevery day\b/gi, "todos los días"],
  [/\bby mouth\b/gi, "por la boca"],
  [/\bas needed\b/gi, "según sea necesario"],
  [/\bfor (\d+) more days\b/gi, "por $1 días más"],
  [/\bwithin about (\d+) week\b/gi, "dentro de aproximadamente $1 semana"],
  [/\bwithin (\d+) week\b/gi, "dentro de $1 semana"],
  [/\bas arranged\b/gi, "según lo programado"],
  [/\bas directed\b/gi, "según las indicaciones"],
  [/\bas scheduled\b/gi, "según lo programado"],
  [/\bToday\b/g, "Hoy"],
  [/\btoday\b/g, "hoy"],
  [/\bYou were in the hospital\b/g, "Estuvo en el hospital"],
  [/\bYou are going home with\b/g, "Se va a casa con"],
  [/\bnew medicines?\b/gi, "medicinas nuevas"],
  [/\bStop or hold:/g, "Suspenda o pause:"],
  [/\bTake your medicines exactly as listed and call your care team if you are not sure about anything\.?/g, "Tome sus medicinas exactamente como se indica y llame a su equipo de atención si tiene dudas."],
  [/\bTake\b/g, "Tome"],
  [/\bSee\b/g, "Vea a"],
  [/\bCall your doctor\b/gi, "Llame a su médico"],
  [/\bprimary care\b/gi, "médico de cabecera"],
  [/\bcardiology\b/gi, "cardiología"],
  [/\burology\b/gi, "urología"],
  [/\bpulmonology\b/gi, "neumología"],
  [/\bChest pain or pressure\b/gi, "Dolor o presión en el pecho"],
  [/\bchest pain\b/gi, "dolor en el pecho"],
  [/\bshortness of breath\b/gi, "falta de aire"],
  [/\bfever\b/gi, "fiebre"],
  [/\bswelling\b/gi, "hinchazón"],
  [/\bweight\b/gi, "peso"],
  [/\bhigh blood pressure\b/gi, "presión arterial alta"],
  [/\bheart failure\b/gi, "insuficiencia cardíaca"],
  [/\bA new medicine your care team started\.?/g, "Una medicina nueva que su equipo de atención empezó."],
  [/\bKeep taking this medicine as before\.?/g, "Siga tomando esta medicina como antes."],
  [/\bYour care team stopped or held this medicine\.?/g, "Su equipo de atención suspendió o pausó esta medicina."],
  [/\bCheck your recovery and your medicines\b/g, "Revisar su recuperación y sus medicinas"],
  [/\bWhich of my medicines are new, which continue, and which should I stop\?/g, "¿Cuáles de mis medicinas son nuevas, cuáles sigo y cuáles debo dejar?"],
  [/\bWhat warning signs mean I should call you, and which mean I should call 911\?/g, "¿Qué señales de alarma significan que debo llamarlos, y cuáles que debo llamar al 911?"],
  [/\bWhen is my next appointment, and what tests do I need before it\?/g, "¿Cuándo es mi próxima cita y qué pruebas necesito antes?"],
];

export function spanishPhrases(s: string): string {
  let out = s;
  for (const [re, rep] of ES) out = out.replace(re, rep);
  return out;
}
