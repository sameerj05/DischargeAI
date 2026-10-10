import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_OUTPUT_KEYS, AiOutputSchema } from "../src/agents/aiOutput.js";
import { OfflineTranslator } from "../src/agents/offline/translator.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("GET /p/:token (the diagram's secure-link read)", () => {
  let t: TestApp;
  const translator = new OfflineTranslator();
  const spy = vi.spyOn(translator, "translate");
  let linkId: string;

  beforeAll(async () => {
    t = await createTestApp({ translator });
    ({ linkId } = await ingestText(t, exampleText("example-1-chf"), { languages: ["es"] }));
  });
  afterAll(() => t.close());

  it("ingest with languages[] translates them at synthesis and reports it in the 202", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", list.patients[1].id).field("text", exampleText("example-2-sepsis-uti")).field("languages", "es,Mandarin").field("language", "Arabic");
    expect(res.status).toBe(202);
    expect(res.body.patientUrl).toBe(`/p/${res.body.linkId}`);
    expect(res.body.language).toBe("ar");
    expect(res.body.synthesisLanguages).toEqual(["ar", "es", "zh"]);
    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.meta.languages).toEqual(["en", "ar", "es", "zh"]);
    const view = await request(t.app).get(`/p/${res.body.linkId}`);
    expect(view.body.meta.languages.ready.sort()).toEqual(["ar", "en", "es", "zh"]);
    const bad = await t.provider(request(t.app).post("/ingest")).field("patientId", list.patients[1].id).field("text", "x y z").field("languages", "klingon");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("unsupported_language");
  });

  it("serves the fixed per-language contract with meta beside it, validated against the schema", async () => {
    const res = await request(t.app).get(`/p/${linkId}`);
    expect(res.status).toBe(200);
    for (const k of AI_OUTPUT_KEYS) expect(Array.isArray(res.body[k]), k).toBe(true);
    const { meta, ...contract } = res.body;
    expect(AiOutputSchema.safeParse(contract).success).toBe(true);
    expect(contract.language).toBe("en");
    expect(contract.readingLevel).toBe("grade5");
    expect(contract.medications.find((m: { name: string }) => m.name === "Furosemide")).toMatchObject({ dose: "40 mg", status: "new" });
    expect(contract.warnings.some((w: { tier: string }) => w.tier === "call911")).toBe(true);
    expect(meta).toMatchObject({ status: "ready", needsReview: false, daysLeft: 30, language: "en", languageName: "English", fromCache: true });
    expect(meta.languages.ready).toEqual(["en", "es"]);
    expect(meta.languages.supported).toContain("ar");
    expect(meta.safetyChecks).toMatchObject({ fidelity: "passed", warnings: [] });
    expect(meta.provenance).toMatchObject({ provider: "offline", inputKind: "text", synthesisCount: 1 });
    expect(meta.provenance.stages).toEqual(["simplify:offline", "safetyCheck:deterministic", "translate:offline"]);
    expect(meta.checklistState).toEqual([]);
    expect(meta.expiresAt).toBeDefined();
    // The same record through the note's endpoint is the richer shape the contract was projected from.
    const rich = await request(t.app).get(`/summary?link=${linkId}`);
    expect(rich.body.medications.new[0]).toMatchObject({ name: "Furosemide", dose: "40 mg" });
    expect(rich.body.readyLanguages).toEqual(["en", "es"]);
    expect(rich.body.verification.synthesisCount).toBe(1);
  });

  it("?language= picked at ingest is served from the store; another language is translated once, then cached", async () => {
    const calls = spy.mock.calls.length;
    const es = await request(t.app).get(`/p/${linkId}?language=Spanish`);
    expect(es.status).toBe(200);
    expect(es.body.language).toBe("es");
    expect(es.body.meta.fromCache).toBe(true);
    expect(es.body.meta.safetyChecks.backTranslationCheck).toBe("passed");
    expect(es.body.medications.map((m: { name: string; dose: string }) => `${m.name}|${m.dose}`)).toEqual(
      (await request(t.app).get(`/p/${linkId}`)).body.medications.map((m: { name: string; dose: string }) => `${m.name}|${m.dose}`),
    );
    expect(spy.mock.calls.length).toBe(calls);

    const first = await request(t.app).get(`/p/${linkId}?language=pt`);
    expect(first.status).toBe(200);
    expect(first.body.meta.fromCache).toBe(false);
    expect(first.body.meta.languages.ready).toEqual(["en", "es", "pt"]);
    expect(spy.mock.calls.length).toBe(calls + 1);
    const second = await request(t.app).get(`/p/${linkId}?language=pt`);
    expect(second.body.meta.fromCache).toBe(true);
    expect(spy.mock.calls.length).toBe(calls + 1);
    // /translate is the same loader: the cached Portuguese comes back without another agent call.
    const alias = await request(t.app).get(`/translate?link=${linkId}&language=pt`);
    expect(alias.body.fromCache).toBe(true);
    expect(spy.mock.calls.length).toBe(calls + 1);

    const bad = await request(t.app).get(`/p/${linkId}?language=klingon`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("unsupported_language");
  });

  it("uses the same 400 / 404 / 410 / 425 rules as /summary", async () => {
    expect((await request(t.app).get("/p/not-a-token")).status).toBe(400);
    expect((await request(t.app).get("/p/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);

    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const pending = await t.provider(request(t.app).post("/ingest")).field("patientId", list.patients[2].id).field("text", exampleText("example-3-hfpef-cellulitis"));
    const early = await request(t.app).get(`/p/${pending.body.linkId}`);
    expect([200, 425]).toContain(early.status);
    await t.ctx.queue.onIdle();

    await t.provider(request(t.app).post("/admin/clock/advance")).send({ days: 30 });
    const expired = await request(t.app).get(`/p/${linkId}`);
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe("link_expired");
    await t.provider(request(t.app).post("/admin/purge"));
    const purged = await request(t.app).get(`/p/${linkId}?language=es`);
    expect(purged.status).toBe(410);
    expect(purged.body.error).toBe("link_purged");
    await t.provider(request(t.app).post("/admin/clock/reset"));
  });
});
