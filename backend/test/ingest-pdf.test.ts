import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPdfText, looksLikePdf } from "../src/extract/pdf.js";
import { createTestApp, examplePdf, type TestApp } from "./helpers.js";

describe("ingest PDF", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("extracts text from the Example 1 PDF fixture", async () => {
    const buf = examplePdf("example-1-chf");
    expect(looksLikePdf(buf)).toBe(true);
    const r = await extractPdfText(buf);
    expect(r.pages).toBeGreaterThan(0);
    expect(r.text).toContain("Furosemide 40 mg");
    expect(r.text).toContain("Amoxicillin-clavulanate 875/125 mg");
  });

  it("ingests the PDF through the pipeline to done", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", list.patients[1].id)
      .attach("file", examplePdf("example-1-chf"), { filename: "example-1-chf.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(202);
    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.inputKind).toBe("pdf");
    expect(job.body.meta.pdfPages).toBeGreaterThan(0);
    const summary = await request(t.app).get(`/summary?link=${res.body.linkId}`);
    expect(summary.status).toBe(200);
    expect(summary.body.medications.new.some((m: { name: string }) => m.name === "Losartan")).toBe(true);
  });

  it("rejects a non-PDF upload as empty_input", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", list.patients[1].id)
      .attach("file", Buffer.from("hello"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("empty_input");
  });

  it("accepts an audio clip and uses the offline transcript", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", list.patients[2].id)
      .attach("audio", Buffer.from("RIFF....WAVEfmt fake audio bytes"), { filename: "dictation.wav", contentType: "audio/wav" });
    expect(res.status).toBe(202);
    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.inputKind).toBe("audio");
    expect(job.body.meta.transcribeProvider).toBe("offline");
    // Provenance reports all four lane-3 stages for a dictated clip, transcribe first.
    expect(job.body.meta.stages).toEqual(["transcribe:offline", "simplify:offline", "safetyCheck:deterministic", "translate:offline"]);
    const summary = await request(t.app).get(`/summary?link=${res.body.linkId}`);
    expect(summary.status).toBe(200);
    expect(summary.body.medications.new.map((m: { name: string }) => m.name)).toContain("Furosemide");
    const view = await request(t.app).get(`/p/${res.body.linkId}`);
    expect(view.status).toBe(200);
    expect(view.body.meta.provenance).toMatchObject({ inputKind: "audio", stages: ["transcribe:offline", "simplify:offline", "safetyCheck:deterministic", "translate:offline"] });
  });
});
