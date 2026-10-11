import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { Clock } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { NO_SECRETS, type AppContext } from "../src/context.js";
import { createLogger } from "../src/logger.js";
import { runIngestJob, type PendingInput } from "../src/pipeline/ingestJob.js";
import type { JobRecord } from "../src/db/repos/jobs.js";
import type { ActiveLink } from "../src/db/repos/activeLinks.js";
import type { SummaryItem } from "../src/docstore/types.js";
import { adaptSummary } from "../scripts/verification/planAdapter.js";
import { getPatients, getJob, postAudio, postIngest, getSummary, ApiError } from "./support/api.js";

test("the verification adapter recognizes the hackathon runtime's result response", () => {
  const adapted = adaptSummary({ sumId: "A".repeat(43), patientID: "test", status: "ready",
    "llm-summary": { result: "# Your Going-Home Plan\nSynthetic plan", status: "approved", flags: [] },
    createdAt: "2026-10-11T12:00:00Z", expiresAt: "2026-11-10T12:00:00Z", daysLeft: 30 });
  assert.equal(adapted.summary, "# Your Going-Home Plan\nSynthetic plan");
  assert.equal(adapted.status, "approved");
  assert.equal(adapted.record.byLang.en, undefined);
});

// Test doubles are isolated to this test; the running app continues to require AWS/RDS.
function harness() {
  const items = new Map<string, SummaryItem>();
  const links = new Map<string, ActiveLink>();
  const jobs = new Map<string, JobRecord>();
  const pending = new Map<string, PendingInput | undefined>();
  const objects = new Map<string, Buffer>();
  const notes: { notes: string; session: string }[] = [];
  const deliveries: unknown[] = [];
  const agentResponse = {
    status: "needs_clinician_check", flags: ["Confirm follow-up date"], summary: "# Going-home plan\nFollow your clinician's instructions.",
    plan: { why_in_hospital: [{ text: "Observation", proof: ["private source quote"] }],
      schedule: { twice_daily: [{ medicine: "Medication from notes", purpose: "As prescribed", note: "For 3 days" }] },
      new_medicines: [], changed_medicines: [{ medicine: "Changed medicine", explanation: "Use the changed dose" }],
      stopped_medicines: [{ medicine: "Old medicine", status: "ON HOLD", explanation: "As instructed" }], tests: [],
      appointments: [{ who: "Care team", when: "Next week", where: "Clinic", why: "Review", date_known: false }],
      care_instructions: [{ text: "Rest as instructed" }], questions_for_care_team: [{ text: "When can I return?" }],
      call_doctor_if: [{ text: "Symptoms worsen" }], get_help_now_if: [{ text: "Emergency symptoms" }],
    },
  };
  const patient = { id: "7", idValue: 7, firstName: "Test", lastName: "Patient", dateOfBirth: "2000-01-01", zipCode: null,
    email: "patient@example.test", phone: null, caregiverEmail: "caregiver@example.test", caregiverName: null, preferredLanguage: null };
  const store = {
    name: "s3", describe: () => "test objects", put: async (i: { key: string; body: Buffer }) => { objects.set(i.key, i.body); },
    delete: async (key: string) => objects.delete(key),
  };
  const ctx = {
    config: loadConfig({}, { LOG_LEVEL: "silent", SECRETS_BOOTSTRAP: "off", PURGE_INTERVAL_MS: 0 }),
    secrets: NO_SECRETS, log: createLogger("silent"), clock: new Clock(), linkTtlDays: 30,
    db: { describe: "test SQL" }, queue: { size: 0 }, receipts: { name: "sql" },
    patients: { list: async () => [patient], getById: async (id: string) => id === "7" ? patient : undefined },
    summaries: {
      name: "dynamo", describe: "test store", put: async (i: SummaryItem) => { items.set(i.uid, i); }, get: async (id: string) => items.get(id) ?? null,
      update: async (id: string, patch: Partial<SummaryItem>) => { Object.assign(items.get(id)!, patch); }, delete: async (id: string) => items.delete(id),
    },
    activeLinks: {
      create: async (i: ActiveLink) => { links.set(i.sumId, { ...i, status: "pending" }); },
      getBySumId: async (id: string) => links.get(id), activeForPatient: async () => undefined,
      setStatus: async (id: string, status: ActiveLink["status"]) => { links.get(id)!.status = status; },
      touchViewed: async () => {}, markEmailed: async () => {},
    },
    jobs: {
      create: async (i: { sumId: string; inputKind: JobRecord["inputKind"]; now: string; meta: Record<string, unknown> }) => {
        const job: JobRecord = { id: randomUUID(), sumId: i.sumId, inputKind: i.inputKind, stage: "received", error: null, meta: i.meta, createdAt: i.now, updatedAt: i.now };
        jobs.set(job.id, job); return job;
      }, get: async (id: string) => jobs.get(id), latestForLink: async (id: string) => [...jobs.values()].find(j => j.sumId === id),
      setStage: async (id: string, stage: JobRecord["stage"], _now: string, error?: string) => { Object.assign(jobs.get(id)!, { stage, error: error ?? null }); },
      mergeMeta: async (id: string, patch: Record<string, unknown>) => { Object.assign(jobs.get(id)!.meta, patch); },
    },
    audit: { append: async () => {} }, pdf: store, audio: store,
    agent: { name: "agentcore", runtimeArn: "test runtime", invoke: async (text: string, sessionId: string) => {
      notes.push({ notes: text, session: sessionId }); return { response: agentResponse, sessionId, latencyMs: 1 };
    } },
    speechToText: { name: "transcribe", transcribe: async () => ({ transcript: "Recorded clinician notes", provider: "test", latencyMs: 1 }) },
    mailer: { transportName: "test", send: async (mail: unknown) => { deliveries.push(mail); return { transport: "test", messageId: "test" }; } },
    patientUrl: (id: string) => `http://localhost:5173/s/${id}`,
    enqueueIngest: (id: string, input?: PendingInput) => { pending.set(id, input); },
  } as unknown as AppContext;
  return { ctx, items, links, jobs, pending, notes, objects, deliveries, agentResponse };
}

test("the backend HTTP contract runs through the real routes, ingest pipeline, and verification adapter", async () => {
  const h = harness();
  const server = buildApp(h.ctx).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => nativeFetch(typeof input === "string" && input.startsWith("/api") ? `${origin}${input}` : input, init);
  try {
    await assert.rejects(getPatients("wrong"), (err: unknown) => err instanceof ApiError && err.status === 401);
    assert.equal((await getPatients("dev-provider-key"))[0].ID, 7);
    const health = await nativeFetch(`${origin}/api/health`); assert.equal(health.status, 200);
    assert.equal((await health.json()).providers.llm, "agentcore");
    const detail = await nativeFetch(`${origin}/api/patients/7`, { headers: { "x-provider-key": "dev-provider-key" } });
    assert.equal(detail.status, 200); assert.equal((await detail.json()).ID, 7);
    const raw = await nativeFetch(`${origin}/patients`, { headers: { "x-provider-key": "dev-provider-key" } });
    assert.equal(raw.status, 200, "legacy provider route stays available");
    const docs = await nativeFetch(`${origin}/api/docs/`);
    assert.equal(docs.status, 200); assert.match(await docs.text(), /swagger-ui/);
    const spec = await (await nativeFetch(`${origin}/api/openapi.json`)).json();
    assert.equal(spec.servers[0].url, "/api");
    for (const path of ["/patients", "/ingest", "/jobs/{jobId}", "/synthesize", "/p/{token}", "/translation"]) assert.ok(spec.paths[path], path);
    const unknown = await nativeFetch(`${origin}/api/missing`); assert.equal(unknown.status, 404);
    const malformed = await nativeFetch(`${origin}/api/ingest`, { method: "POST", headers: { "x-provider-key": "dev-provider-key", "content-type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    await assert.rejects(postIngest({ patientID: "7", type: "text", data: "" }, "dev-provider-key"), (err: unknown) => err instanceof ApiError && err.status === 400);
    const ingest = await postIngest({ patientID: "7", type: "text", data: "Clinician notes" }, "dev-provider-key");
    assert.equal(ingest.statusCode, 202); assert.match(ingest.sumId, /^[A-Za-z0-9_-]{43}$/); assert.ok(ingest.link.endsWith(`/s/${ingest.sumId}`));
    assert.equal(h.items.get(ingest.sumId)!["raw-text"], "Clinician notes");
    await assert.rejects(getSummary(ingest.sumId), (err: unknown) => err instanceof ApiError && err.status === 425);
    await runIngestJob(h.ctx, ingest.jobId);
    assert.equal((await getJob(ingest.jobId, "dev-provider-key")).stage, "done");
    assert.equal(h.notes[0].session, ingest.sumId); assert.equal(h.notes[0].notes, "Clinician notes");
    assert.equal(h.deliveries.length, 2);
    const summary = await getSummary(ingest.sumId);
    assert.deepEqual(summary["llm-summary"], h.agentResponse, "agent output is preserved");
    for (const path of [`/llm-sumary?sum-id=${ingest.sumId}`, `/llm-summary?sum_id=${ingest.sumId}`, `/summary?link=${ingest.sumId}`]) {
      const alias = await nativeFetch(`${origin}/api${path}`);
      assert.equal(alias.status, 200); assert.deepEqual((await alias.json())["llm-summary"], h.agentResponse);
    }
    const adapted = adaptSummary(summary);
    const plan = adapted.record.byLang.en!;
    assert.equal(plan.medications.groups[0].key, "twiceDaily"); assert.equal(plan.medications.groups[0].items.length, 2);
    assert.equal(plan.medications.groups.some(g => g.key === "morning"), false, "frequency does not invent a clock time");
    assert.ok(plan.generalInstructions.some(s => s.includes("Symptoms worsen")));
    assert.ok(plan.generalInstructions.some(s => s.includes("When can I return")));
    assert.equal(plan.stoppedMedicines[0].detail, "ON HOLD; As instructed");
    assert.equal(JSON.stringify(plan).includes("private source quote"), false);
    assert.equal(adapted.record.expiresAt, ingest.expiresAt); assert.equal(adapted.flags[0], "Confirm follow-up date");
    for (const path of ["/translation", "/translate"]) {
      const translate = await nativeFetch(`${origin}/api${path}?lang=es&sum_id=${ingest.sumId}`); assert.equal(translate.status, 404);
    }
    const audio = await postAudio(new Blob(["synthetic audio"], { type: "audio/webm" }), "7", "dev-provider-key");
    await runIngestJob(h.ctx, audio.jobId, h.pending.get(audio.jobId));
    assert.equal((await getJob(audio.jobId, "dev-provider-key")).stage, "done");
    assert.equal(h.items.get(audio.sumId)!["raw-text"], "Recorded clinician notes");
    assert.equal(h.notes[1].notes, "Recorded clinician notes");
    const pdf = readFileSync(join(import.meta.dirname, "fixtures/synthetic-discharge.pdf")).toString("base64");
    const pdfIngest = await postIngest({ patientID: "7", type: "pdf", data: pdf }, "dev-provider-key");
    assert.ok(h.items.get(pdfIngest.sumId)!["raw-text"]!.includes("Furosemide"));
    await runIngestJob(h.ctx, pdfIngest.jobId);
    assert.equal((await getJob(pdfIngest.jobId, "dev-provider-key")).stage, "done");
    const resynthesized = await nativeFetch(`${origin}/api/synthesize`, { method: "POST", headers: { "x-provider-key": "dev-provider-key", "content-type": "application/json" }, body: JSON.stringify({ sumId: ingest.sumId }) });
    assert.equal(resynthesized.status, 200);
    h.links.get(ingest.sumId)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(getSummary(ingest.sumId), (err: unknown) => err instanceof ApiError && err.status === 410);
    await assert.rejects(getSummary("A".repeat(43)), (err: unknown) => err instanceof ApiError && err.status === 404);
    const spa = await nativeFetch(`${origin}/s/${audio.sumId}`); assert.equal(spa.status, 200); assert.match(await spa.text(), /id="root"/);
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
