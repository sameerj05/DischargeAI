import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("ingest text -> job -> summary", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("rejects empty input with 400 empty_input", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", list.patients[0].id).field("text", "   \n ");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("empty_input");
  });

  it("rejects an unknown patient with 404", async () => {
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", "nope").field("text", "Furosemide 40 mg daily");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("answers 202 with a link, runs the pipeline to done, emails the patient, serves the summary", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const patientId = list.patients[0].id;
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", patientId).field("text", exampleText("example-1-chf"));
    expect(res.status).toBe(202);
    expect(res.body.message).toBe("ingestion started");
    expect(res.body.linkId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.body.link).toBe(`http://localhost:5173/s/${res.body.linkId}`);
    expect(res.body.statusUrl).toBe(`/jobs/${res.body.jobId}`);
    const created = new Date(res.body.expiresAt).getTime() - t.ctx.clock.now().getTime();
    expect(Math.round(created / (24 * 3600 * 1000))).toBe(30);

    await t.ctx.queue.onIdle();

    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.status).toBe(200);
    expect(job.body.stage).toBe("done");
    expect(job.body.warnings).toEqual([]);
    expect(job.body.meta.fixture).toBe("example-1");

    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0].to).toBe(list.patients[0].email);
    expect(t.mailer.sent[0].text).toContain(res.body.link);
    expect(t.mailer.sent[0].text).not.toContain("Furosemide");

    const summary = await request(t.app).get(`/summary?link=${res.body.linkId}`);
    expect(summary.status).toBe(200);
    expect(summary.body.readingLevel).toBe("grade5");
    expect(summary.body.medications.new.map((m: { name: string; dose: string }) => `${m.name} ${m.dose}`)).toContain("Furosemide 40 mg");
    expect(summary.body.daysLeft).toBe(30);
    expect(summary.body.needsReview).toBe(false);
    expect(summary.body.verification.fidelityCheck).toBe("passed");
    expect(summary.body.checklistState).toEqual([]);

    const patient = await t.provider(request(t.app).get(`/patients/${patientId}`));
    expect(patient.body.activeLinkId).toBe(res.body.linkId);

    const audit = await t.provider(request(t.app).get(`/audit?link=${res.body.linkId}`));
    const events = audit.body.events.map((e: { event: string }) => e.event);
    expect(events).toContain("link.created");
    expect(events).toContain("email.sent");
    expect(events).toContain("summary.viewed");
    expect(JSON.stringify(audit.body)).not.toContain("Furosemide");
  });

  it("falls back to rule-based extraction for text that matches no fixture", async () => {
    const text = [
      "Discharge diagnoses:",
      "• Community-acquired pneumonia",
      "• Hypertension",
      "Discharge Medications",
      "New medications",
      "• Azithromycin 250 mg by mouth once daily for 4 additional days.",
      "Continue",
      "• Amlodipine 10 mg daily.",
      "Stopped/held",
      "• Lisinopril — held pending blood pressure recheck.",
      "Discharge Instructions",
      "• Follow up with primary care within 1 week.",
      "Return Precautions",
      "• Chest pain.",
      "• Fever above 101 F.",
    ].join("\n");
    const { linkId, jobId } = await ingestText(t, text);
    const job = await t.provider(request(t.app).get(`/jobs/${jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.meta.model).toBe("rules");
    const summary = await request(t.app).get(`/summary?link=${linkId}`);
    expect(summary.body.medications.new[0]).toMatchObject({ name: "Azithromycin", dose: "250 mg" });
    expect(summary.body.medications.stop[0].name).toBe("Lisinopril");
    expect(summary.body.followUps[0].who).toBe("primary care");
    expect(summary.body.returnPrecautions.call911).toContain("Chest pain.");
  });

  it("emails the caregiver only when the patient approved it", async () => {
    const before = t.mailer.sent.length;
    await ingestText(t, exampleText("example-2-sepsis-uti"), { caregiverEmail: "care@example.test" });
    expect(t.mailer.sent.length).toBe(before + 1);
    await ingestText(t, exampleText("example-2-sepsis-uti"), { caregiverEmail: "care@example.test", caregiverApproved: "true" });
    expect(t.mailer.sent.length).toBe(before + 3);
    expect(t.mailer.sent[t.mailer.sent.length - 1].to).toBe("care@example.test");
  });
});
