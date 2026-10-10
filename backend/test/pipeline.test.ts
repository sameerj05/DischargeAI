import { describe, expect, it } from "vitest";
import { AiOutputSchema, FIDELITY_NOTICE } from "../src/agents/aiOutput.js";
import { loadSimplifiedFixture } from "../src/agents/offline/fixtures.js";
import { OfflineSimplifier } from "../src/agents/offline/simplifier.js";
import { OfflineTranscriber } from "../src/agents/offline/transcriber.js";
import { OfflineTranslator } from "../src/agents/offline/translator.js";
import { createPipeline, resolveLanguages, type SimplifyStage } from "../src/agents/pipeline.js";
import { exampleText } from "./helpers.js";

const pipeline = () => createPipeline({ transcriber: new OfflineTranscriber(), simplifier: new OfflineSimplifier(), translator: new OfflineTranslator() });

describe("lane-3 pipeline: transcribe -> simplify -> safety check -> translate", () => {
  it("returns one contract object per language (en always), validated, medications verbatim everywhere", async () => {
    const stages: string[] = [];
    const r = await pipeline().run({ rawText: exampleText("example-1-chf"), languages: ["es", "Mandarin", "ar", "es", "klingon"], onStage: (s) => void stages.push(s) });
    expect(Object.keys(r.perLanguage)).toEqual(["en", "es", "zh", "ar"]);
    expect(r.meta.unsupportedLanguages).toEqual(["klingon"]);
    expect(r.meta.safetyChecks).toMatchObject({ fidelity: "passed", patientNoticeAdded: false, warnings: [] });
    expect(r.meta.stages).toEqual(["simplify:offline", "safetyCheck:deterministic", "translate:offline"]);
    expect(stages).toEqual(["simplifying", "checking", "translating", "translating", "translating"]);
    expect(r.meta.inputKind).toBe("text");
    const enMeds = r.perLanguage.en.medications.map((m) => `${m.status}|${m.name}|${m.dose}`);
    for (const [lang, out] of Object.entries(r.perLanguage)) {
      expect(AiOutputSchema.safeParse(out).success, lang).toBe(true);
      expect(out.language).toBe(lang);
      expect(out.medications.map((m) => `${m.status}|${m.name}|${m.dose}`), lang).toEqual(enMeds);
      expect(out.steps.map((s) => s.id), lang).toEqual(r.perLanguage.en.steps.map((s) => s.id));
      expect(out.warnings.length, lang).toBe(r.perLanguage.en.warnings.length);
    }
    expect(r.perLanguage.es.summary).toContain("hospital");
    expect(r.perLanguage.es.summary).not.toBe(r.perLanguage.en.summary);
    expect(r.meta.translations.es.backTranslationCheck).toBe("passed");
    expect(r.summaries.en).toEqual(loadSimplifiedFixture("example-1"));
  });

  it("runs the transcribe stage for audio input", async () => {
    const r = await pipeline().run({ audio: { buffer: Buffer.from("RIFF....WAVEfmt fake"), mimeType: "audio/wav" } });
    expect(r.meta.inputKind).toBe("audio");
    expect(r.meta.transcribe?.provider).toBe("offline");
    expect(r.meta.stages[0]).toBe("transcribe:offline");
    expect(r.rawText).toContain("Furosemide 40 mg");
    expect(r.perLanguage.en.medications.some((m) => m.name === "Furosemide" && m.dose === "40 mg")).toBe(true);
  });

  it("a swapped simplify stage that changes a dose fails the safety check and the patient is told in every language", async () => {
    const lying: SimplifyStage = {
      name: "simplify:test-wrong-dose",
      async run() {
        const s = loadSimplifiedFixture("example-1");
        s.medications.new[0].dose = "80 mg";
        return { summary: s, provider: "test", model: "wrong-dose" };
      },
    };
    const p = createPipeline({ transcriber: new OfflineTranscriber(), simplifier: new OfflineSimplifier(), translator: new OfflineTranslator(), stages: { simplify: lying } });
    const r = await p.run({ rawText: exampleText("example-1-chf"), languages: ["es"] });
    expect(r.meta.safetyChecks.fidelity).toBe("failed");
    expect(r.meta.safetyChecks.warnings.map((w) => w.code)).toContain("dose_not_in_source");
    expect(r.meta.safetyChecks.patientNoticeAdded).toBe(true);
    expect(r.perLanguage.en.warnings).toContainEqual({ tier: "clinic", text: FIDELITY_NOTICE });
    expect(r.perLanguage.es.warnings.filter((w) => w.tier === "clinic").length).toBe(r.perLanguage.en.warnings.filter((w) => w.tier === "clinic").length);
    expect(r.perLanguage.es.medications[0].dose).toBe("80 mg");
  });

  it("rejects empty input", async () => {
    await expect(pipeline().run({ rawText: "   " })).rejects.toThrow("pipeline_empty_input");
  });

  it("resolves names, codes and aliases and never duplicates en", () => {
    const { languages, unsupported } = resolveLanguages(["English", "Spanish", "es-MX", "Chinese", "zh", "Arabic", "xx"]);
    expect(languages.map((l) => l.code)).toEqual(["es", "zh", "ar"]);
    expect(unsupported).toEqual(["xx"]);
  });
});
