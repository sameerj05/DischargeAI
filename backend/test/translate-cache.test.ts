import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OfflineTranslator } from "../src/agents/offline/translator.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("translate", () => {
  let t: TestApp;
  const translator = new OfflineTranslator();
  const spy = vi.spyOn(translator, "translate");
  let linkId: string;

  beforeAll(async () => {
    t = await createTestApp({ translator });
    ({ linkId } = await ingestText(t, exampleText("example-1-chf")));
  });
  afterAll(() => t.close());

  it("lists supported languages", async () => {
    const res = await request(t.app).get("/languages");
    expect(res.status).toBe(200);
    expect(res.body.languages.find((l: { code: string }) => l.code === "es")).toMatchObject({ name: "Spanish" });
  });

  it("rejects an unsupported language", async () => {
    const res = await request(t.app).get(`/translate?link=${linkId}&language=klingon`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_language");
  });

  it("translates on the first call and serves the cache on the second (agent called once)", async () => {
    const first = await request(t.app).get(`/translate?link=${linkId}&language=Spanish`);
    expect(first.status).toBe(200);
    expect(first.body.fromCache).toBe(false);
    expect(first.body.language).toBe("es");
    expect(first.body.summary).toContain("hospital");
    expect(first.body.medications.new[0]).toMatchObject({ name: "Furosemide", dose: "40 mg" });
    expect(first.body.verification.backTranslationCheck).toBe("passed");
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await request(t.app).get(`/translate?link=${linkId}&language=es`);
    expect(second.status).toBe(200);
    expect(second.body.fromCache).toBe(true);
    expect(second.body.summary).toBe(first.body.summary);
    expect(spy).toHaveBeenCalledTimes(1);

    const audit = await t.provider(request(t.app).get(`/audit?link=${linkId}`));
    const events = audit.body.events.map((e: { event: string }) => e.event);
    expect(events).toContain("translation.created");
    expect(events).toContain("translation.viewed");
  });

  it("keeps medication names and doses verbatim in a non-fixture language", async () => {
    const res = await request(t.app).get(`/translate?link=${linkId}&language=pt`);
    expect(res.status).toBe(200);
    expect(res.body.medications.new.map((m: { name: string; dose: string }) => `${m.name}|${m.dose}`)).toEqual([
      "Furosemide|40 mg",
      "Losartan|25 mg",
      "Empagliflozin|10 mg",
      "Amoxicillin-clavulanate|875/125 mg",
    ]);
  });
});
