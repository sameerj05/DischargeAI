import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSimplifiedFixture, loadTranslationFixture } from "../src/agents/offline/fixtures.js";
import { OfflineTranslator } from "../src/agents/offline/translator.js";
import { SimplifiedSummarySchema } from "../src/agents/types.js";
import { checkTranslation } from "../src/verify/backtranslate.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

/**
 * The diagram's three Translate targets (Spanish, Mandarin, Arabic) each have a curated Example 1
 * fixture so the offline provider demos the toggle with real text, not a marked passthrough.
 */
describe("offline translations: es, zh, ar fixtures for Example 1", () => {
  const en = loadSimplifiedFixture("example-1");

  it.each(["es", "zh", "ar"])("%s mirrors the English structure, keeps every medication name and dose verbatim", (lang) => {
    const t = loadTranslationFixture("example-1", lang)!;
    expect(t).toBeDefined();
    expect(SimplifiedSummarySchema.safeParse(t).success).toBe(true);
    expect(t.language).toBe(lang);
    expect(t.diagnoses.map((d) => d.clinical)).toEqual(en.diagnoses.map((d) => d.clinical));
    for (const group of ["new", "continue"] as const) {
      expect(t.medications[group].map((m) => `${m.name}|${m.dose}`)).toEqual(en.medications[group].map((m) => `${m.name}|${m.dose}`));
    }
    expect(t.medications.stop.map((m) => m.name)).toEqual(en.medications.stop.map((m) => m.name));
    expect(t.checklist.map((c) => `${c.id}:${c.type}`)).toEqual(en.checklist.map((c) => `${c.id}:${c.type}`));
    expect(t.returnPrecautions.call911.length).toBe(en.returnPrecautions.call911.length);
    expect(t.returnPrecautions.goToER.length).toBe(en.returnPrecautions.goToER.length);
    expect(t.returnPrecautions.callClinic.length).toBe(en.returnPrecautions.callClinic.length);
    expect(t.followUps.length).toBe(en.followUps.length);
    expect(t.questionsToAsk.length).toBe(en.questionsToAsk.length);
    // Every numeric dose the English text carries is present in the translation (the back-translation diff).
    expect(checkTranslation(en, t, en)).toEqual([]);
    expect(t.summary).not.toBe(en.summary);
  });

  it("the offline translator picks the fixture for the three targets and the passthrough for others", async () => {
    const tr = new OfflineTranslator();
    for (const lang of ["es", "zh", "ar"]) {
      const r = await tr.translate({ summary: en, language: lang, languageName: lang });
      expect(r.fixture).toBe(`example-1.${lang}`);
    }
    const pt = await tr.translate({ summary: en, language: "pt", languageName: "Portuguese" });
    expect(pt.model).toBe("passthrough");
    expect(pt.translation.summary.startsWith("[pt] ")).toBe(true);
  });

  describe("through the API", () => {
    let t: TestApp;
    let linkId: string;
    beforeAll(async () => {
      t = await createTestApp();
      ({ linkId } = await ingestText(t, exampleText("example-1-chf"), { languages: ["es", "zh", "ar"] }));
    });
    afterAll(() => t.close());

    it("GET /translate serves the Mandarin and Arabic fixtures from the store with the back-translation check passed", async () => {
      for (const [lang, probe] of [
        ["zh", "心脏"],
        ["ar", "قلبك"],
      ] as const) {
        const res = await request(t.app).get(`/translate?link=${linkId}&language=${lang}`);
        expect(res.status).toBe(200);
        expect(res.body.language).toBe(lang);
        expect(res.body.fromCache).toBe(true);
        expect(res.body.summary).toContain(probe);
        expect(res.body.verification.backTranslationCheck).toBe("passed");
        expect(res.body.medications.new[3]).toMatchObject({ name: "Amoxicillin-clavulanate", dose: "875/125 mg" });
      }
      const langs = await request(t.app).get("/languages");
      expect(langs.body.synthesisTargets).toEqual(["es", "zh", "ar"]);
      expect(langs.body.languages.map((l: { code: string }) => l.code).slice(0, 4)).toEqual(["en", "es", "zh", "ar"]);
    });
  });
});
