import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiOutputSchema, FIDELITY_NOTICE } from "../src/agents/aiOutput.js";
import { loadSimplifiedFixture } from "../src/agents/offline/fixtures.js";
import { OfflineSimplifier } from "../src/agents/offline/simplifier.js";
import { OfflineTranscriber } from "../src/agents/offline/transcriber.js";
import { OfflineTranslator } from "../src/agents/offline/translator.js";
import { createPipeline, type SimplifyStage } from "../src/agents/pipeline.js";
import { hashLinkId } from "../src/crypto/linkId.js";
import { uidFor } from "../src/docstore/types.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("POST /synthesize (the diagram's pipeline endpoint)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("needs the provider key", async () => {
    const res = await request(t.app).post("/synthesize").send({ text: "Furosemide 40 mg daily" });
    expect(res.status).toBe(401);
  });

  it("dry run: { text, languages } returns the fixed JSON per language and stores nothing", async () => {
    const res = await t.provider(request(t.app).post("/synthesize")).send({ text: exampleText("example-1-chf"), languages: ["es", "zh"] });
    expect(res.status).toBe(200);
    expect(res.body.stored).toBeNull();
    expect(Object.keys(res.body.perLanguage)).toEqual(["en", "es", "zh"]);
    for (const [lang, out] of Object.entries(res.body.perLanguage)) {
      expect(AiOutputSchema.safeParse(out).success, lang).toBe(true);
      expect((out as { language: string }).language).toBe(lang);
    }
    expect(res.body.meta.safetyChecks).toMatchObject({ fidelity: "passed", patientNoticeAdded: false });
    expect(res.body.meta.translations.es.backTranslationCheck).toBe("passed");
    expect(res.body.perLanguage.en.medications.map((m: { name: string }) => m.name)).toContain("Furosemide");

    const empty = await t.provider(request(t.app).post("/synthesize")).send({ text: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("empty_input");
    const bad = await t.provider(request(t.app).post("/synthesize")).send({ text: "x", languages: ["klingon"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("unsupported_language");
  });

  it("re-synthesis by linkId overwrites the record, adds languages, deletes stale translations with receipts", async () => {
    const { linkId } = await ingestText(t, exampleText("example-1-chf"));
    const hash = hashLinkId(linkId);
    // A lazy Portuguese translation that the re-run will not regenerate: it must be deleted, not served stale.
    await request(t.app).get(`/translate?link=${linkId}&language=pt`);
    expect((await t.ctx.docStore.list(uidFor(hash))).map((d) => d.doc).sort()).toEqual(["raw", "simplified", "translation#pt"]);

    const res = await t.provider(request(t.app).post("/synthesize")).send({ linkId, languages: ["es"] });
    expect(res.status).toBe(200);
    expect(res.body.stored).toMatchObject({ status: "ready", documents: ["simplified", "translation#es"], staleTranslationsDeleted: 1, synthesisCount: 2 });
    expect(Object.keys(res.body.perLanguage)).toEqual(["en", "es"]);
    expect((await t.ctx.docStore.list(uidFor(hash))).map((d) => d.doc).sort()).toEqual(["raw", "simplified", "translation#es"]);

    const view = await request(t.app).get(`/p/${linkId}?language=es`);
    expect(view.body.meta.fromCache).toBe(true);
    expect(view.body.meta.provenance.synthesisCount).toBe(2);
    expect((await t.ctx.links.getByHash(hash))?.languages).toEqual(["es"]);

    const job = await t.provider(request(t.app).get(`/jobs/${res.body.stored.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.meta.synthesize).toBe(true);

    const audit = await t.provider(request(t.app).get(`/audit?link=${linkId}`));
    const events = audit.body.events.map((e: { event: string }) => e.event);
    expect(events).toContain("record.synthesized");
    const stale = audit.body.deletionReceipts.find((r: { event: string; details: Record<string, unknown> }) => r.event === "record.deleted");
    expect(stale.details).toMatchObject({ doc: "translation#pt", table: "discharge_summaries", reason: "resynthesized", job: "synthesize", receipt: true });
  });

  it("new text replaces the stored clinician text; a lying prompt is caught and the link flagged", async () => {
    const { linkId } = await ingestText(t, exampleText("example-2-sepsis-uti"));
    const lying: SimplifyStage = {
      name: "simplify:test-wrong-dose",
      async run() {
        const s = loadSimplifiedFixture("example-1");
        s.medications.new[0].dose = "80 mg";
        return { summary: s, provider: "test", model: "wrong-dose" };
      },
    };
    const saved = t.ctx.pipeline;
    t.ctx.pipeline = createPipeline({ transcriber: new OfflineTranscriber(), simplifier: new OfflineSimplifier(), translator: new OfflineTranslator(), stages: { simplify: lying } });
    try {
      const res = await t.provider(request(t.app).post("/synthesize")).send({ linkId, text: exampleText("example-1-chf") });
      expect(res.status).toBe(200);
      expect(res.body.stored.status).toBe("needs_review");
      expect(res.body.meta.safetyChecks.fidelity).toBe("failed");
      expect(res.body.perLanguage.en.warnings).toContainEqual({ tier: "clinic", text: FIDELITY_NOTICE });
    } finally {
      t.ctx.pipeline = saved;
    }
    const view = await request(t.app).get(`/p/${linkId}`);
    expect(view.status).toBe(200);
    expect(view.body.meta.needsReview).toBe(true);
    expect(view.body.meta.safetyChecks.fidelity).toBe("failed");
    expect(view.body.meta.provenance.inputKind).toBe("text");
  });

  it("refuses an unknown, expired or purged linkId", async () => {
    const unknown = await t.provider(request(t.app).post("/synthesize")).send({ linkId: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(unknown.status).toBe(404);
    const malformed = await t.provider(request(t.app).post("/synthesize")).send({ linkId: "nope" });
    expect(malformed.status).toBe(400);
    const { linkId } = await ingestText(t, exampleText("example-4-copd"));
    await t.provider(request(t.app).post("/admin/clock/advance")).send({ days: 30 });
    const expired = await t.provider(request(t.app).post("/synthesize")).send({ linkId });
    expect(expired.status).toBe(410);
    await t.provider(request(t.app).post("/admin/purge"));
    const purged = await t.provider(request(t.app).post("/synthesize")).send({ linkId });
    expect(purged.status).toBe(410);
    expect(purged.body.error).toBe("link_purged");
    await t.provider(request(t.app).post("/admin/clock/reset"));
  });
});
