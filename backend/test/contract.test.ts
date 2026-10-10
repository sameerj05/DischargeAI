import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AiOutput as PublishedAiOutput } from "../contracts/ai-output.js";
import { AI_OUTPUT_KEYS, AiOutputSchema, FIDELITY_NOTICE, aiOutputJsonSchema, toAiOutput, withPatientNotice } from "../src/agents/aiOutput.js";
import { loadSimplifiedFixture } from "../src/agents/offline/fixtures.js";
import { OfflineTranslator } from "../src/agents/offline/translator.js";
import { createTestApp, type TestApp } from "./helpers.js";

const CONTRACTS = join(import.meta.dirname, "..", "contracts");

/** Compile-time proof that the published TS type and the zod schema describe the same object. */
type ZodAiOutput = z.infer<typeof AiOutputSchema>;
const zodToPublished = (x: ZodAiOutput): PublishedAiOutput => x;
const publishedToZod = (x: PublishedAiOutput): ZodAiOutput => x as ZodAiOutput;
void zodToPublished;
void publishedToZod;

describe("lane-3 contract: fixed per-language JSON", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const published = JSON.parse(readFileSync(join(CONTRACTS, "ai-output.schema.json"), "utf8")) as Record<string, unknown>;
  const validate = ajv.compile(published);

  it("the committed JSON Schema equals the one generated from the zod schema", () => {
    expect(published).toEqual(aiOutputJsonSchema());
  });

  it("projects every curated fixture onto the four keys and validates against the published schema", () => {
    for (const id of ["example-1", "example-2", "example-3", "example-4", "example-5"]) {
      const out = toAiOutput(loadSimplifiedFixture(id));
      for (const k of AI_OUTPUT_KEYS) expect(Array.isArray(out[k]), `${id}.${k}`).toBe(true);
      expect(out.language).toBe("en");
      expect(out.readingLevel).toBe("grade5");
      expect(AiOutputSchema.safeParse(out).success, id).toBe(true);
      expect(validate(out), `${id}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("flattens medications with a status and maps precaution tiers", () => {
    const out = toAiOutput(loadSimplifiedFixture("example-1"));
    expect(out.medications.map((m) => `${m.status}:${m.name}`)).toEqual([
      "new:Furosemide",
      "new:Losartan",
      "new:Empagliflozin",
      "new:Amoxicillin-clavulanate",
      "continue:Metoprolol succinate",
      "continue:Apixaban",
      "continue:Atorvastatin",
      "continue:Metformin",
      "stop:Lisinopril",
      "stop:Spironolactone",
      "stop:Ibuprofen/other NSAIDs",
    ]);
    expect(out.medications.find((m) => m.name === "Furosemide")).toMatchObject({ dose: "40 mg", howOften: "once a day by mouth" });
    expect(out.medications.find((m) => m.name === "Lisinopril")).toMatchObject({ dose: "", howOften: "", status: "stop" });
    expect(out.steps[0]).toMatchObject({ id: "med-1", category: "med" });
    expect(out.warnings.filter((w) => w.tier === "call911")).toHaveLength(4);
    expect(out.warnings.filter((w) => w.tier === "er")).toHaveLength(3);
    expect(out.warnings.filter((w) => w.tier === "clinic")).toHaveLength(3);
    expect(out.followUps).toHaveLength(3);
  });

  it("rejects an object that is missing one of the four keys or uses an unknown tier", () => {
    const good = toAiOutput(loadSimplifiedFixture("example-2"));
    const { steps: _steps, ...missing } = good;
    void _steps;
    expect(AiOutputSchema.safeParse(missing).success).toBe(false);
    expect(validate(missing)).toBe(false);
    const badTier = { ...good, warnings: [{ tier: "urgent", text: "x" }] };
    expect(AiOutputSchema.safeParse(badTier).success).toBe(false);
    expect(validate(badTier)).toBe(false);
  });

  it("a failed fidelity check becomes a clinic-tier warning the patient sees, in every language", async () => {
    const summary = loadSimplifiedFixture("example-1");
    const flagged = withPatientNotice(summary, [{ code: "dose_not_in_source", message: "x", name: "Furosemide", dose: "80 mg" }]);
    expect(toAiOutput(flagged).warnings).toContainEqual({ tier: "clinic", text: FIDELITY_NOTICE });
    expect(withPatientNotice(flagged, [{ code: "dose_not_in_source", message: "x" }]).returnPrecautions.callClinic.filter((t) => t === FIDELITY_NOTICE)).toHaveLength(1);
    expect(withPatientNotice(summary, [{ code: "readability_above_target", message: "x" }])).toEqual(summary);
    const es = await new OfflineTranslator().translate({ summary: flagged, language: "es", languageName: "Spanish" });
    expect(toAiOutput({ ...es.translation, language: "es" }).warnings.some((w) => w.tier === "clinic" && w.text.length > 0)).toBe(true);
  });

  describe("served by the API", () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(() => t.close());

    it("GET /contracts/ai-output.schema.json and /contracts/ai-output.ts need no key and match the files", async () => {
      const index = await request(t.app).get("/contracts");
      expect(index.body.files).toEqual(["/contracts/ai-output.schema.json", "/contracts/ai-output.ts"]);
      const schema = await request(t.app).get("/contracts/ai-output.schema.json");
      expect(schema.status).toBe(200);
      expect(schema.headers["content-type"]).toContain("json");
      expect(JSON.parse(schema.text)).toEqual(published);
      const ts = await request(t.app).get("/contracts/ai-output.ts");
      expect(ts.status).toBe(200);
      expect(ts.headers["content-type"]).toContain("text/plain");
      expect(ts.text).toBe(readFileSync(join(CONTRACTS, "ai-output.ts"), "utf8"));
      const nope = await request(t.app).get("/contracts/../package.json");
      expect(nope.status).toBe(404);
    });
  });
});
