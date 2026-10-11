import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { buildApp, OPENAPI_FILE } from "../src/app.js";
import { createLocalContext, LOCAL_PROVIDER_KEY, LOCAL_FAILURE_MARKER, LOCAL_AUDIO_TRANSCRIPT } from "../scripts/local/context.js";
import { newSumId } from "../src/crypto/sumId.js";

const pdfBytes = () => readFileSync(join(import.meta.dirname, "fixtures/synthetic-discharge.pdf"));
const headers = { "Content-Type": "application/json", "x-provider-key": LOCAL_PROVIDER_KEY };
const post = (body: unknown): RequestInit => ({ method: "POST", headers, body: JSON.stringify(body) });

async function harness(maxUpload?: number) {
  const local = await createLocalContext({ agentDelayMs: 250 });
  if (maxUpload) local.ctx.config.MAX_UPLOAD_BYTES = maxUpload;
  const server = buildApp(local.ctx).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  local.ctx.config.PATIENT_APP_URL = origin;
  return { ...local, origin, async close() { await new Promise<void>(resolve => server.close(() => resolve())); await local.ctx.close(); } };
}

test("every OpenAPI operation is checked against real HTTP routes and SQL repositories", { timeout: 60_000 }, async t => {
  const h = await harness();
  const doc = YAML.parse(readFileSync(OPENAPI_FILE, "utf8"));
  const operations = Object.entries(doc.paths).flatMap(([path, methods]) => Object.keys(methods as object)
    .filter(method => ["get", "post", "put", "patch", "delete"].includes(method)).map(method => `${method.toUpperCase()} ${path}`));
  const exercised = new Set<string>();
  const call = async (path: string, expected: number, init?: RequestInit) => {
    const pathname = path.split("?")[0];
    for (const operation of operations) {
      const [method, route] = operation.split(" ");
      if (method === (init?.method ?? "GET") && new RegExp(`^${route.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(pathname)) exercised.add(operation);
    }
    const response = await fetch(h.origin + "/api" + path, init);
    const body = await response.json();
    assert.equal(response.status, expected, `${init?.method ?? "GET"} ${path}: ${JSON.stringify(body)}`);
    if (expected >= 400) assert.equal(body.statusCode, expected);
    return body;
  };
  let text: { sumId: string; jobId: string; link: string };
  let pdf: typeof text;
  let audio: typeof text;
  let failed: typeof text;
  try {
    await t.test("health, Swagger, routing and CORS", async () => {
      const health = await call("/health", 200);
      assert.equal(health.mode, "local-test"); assert.equal(health.providers.llm, "local-fixture");
      assert.equal((await fetch(h.origin + "/api/docs/")).status, 200);
      assert.deepEqual((await (await fetch(h.origin + "/api/openapi.json")).json()).paths, doc.paths);
      const originalLinkPage = await fetch(h.origin + "/p/demo-token-123", { headers: { Accept: "text/html" } });
      assert.equal(originalLinkPage.status, 200); assert.match(originalLinkPage.headers.get("content-type")!, /text\/html/);
      await call("/not-a-route", 404);
      const preflight = await fetch(h.origin + "/api/ingest", { method: "OPTIONS" });
      assert.equal(preflight.status, 204); assert.match(preflight.headers.get("Access-Control-Allow-Headers")!, /x-provider-key/);
    });
    await t.test("all provider prefixes reject absent or incorrect keys", async () => {
      for (const [path, method] of [["/patients", "GET"], ["/patients/7", "GET"], ["/jobs/unknown", "GET"], ["/ingest", "POST"], ["/synthesize", "POST"]]) {
        for (const key of [undefined, "incorrect"]) {
          const result = await call(path, 401, { method, headers: key ? { "x-provider-key": key } : {} });
          assert.equal(result.error, "provider_key_required");
        }
      }
    });
    await t.test("local login validates credentials on the server", async () => {
      await call("/auth/login", 400, post({ email: 7 }));
      assert.equal((await call("/auth/login", 401, post({ email: "rivera@demo.health", password: "wrong" }))).error, "invalid_credentials");
      const session = await call("/auth/login", 200, post({ email: "rivera@demo.health", password: "demo1234" }));
      assert.equal(session.role, "doctor"); assert.equal(session.providerKey, LOCAL_PROVIDER_KEY);
      assert.equal((await call("/auth/link", 409, post({ token: "demo-token-123", dob: "2000-01-01", role: "patient" }))).error, "no_local_plan");
    });
    await t.test("patient listing and details reflect SQL, including unknown IDs", async () => {
      const patients = (await call("/patients", 200, { headers })).patients;
      assert.deepEqual(patients.map((p: { ID: string | number }) => String(p.ID)), ["7", "8"]);
      const detail = await call("/patients/7", 200, { headers });
      assert.equal(detail.FirstName, "Alex"); assert.equal(detail.activeLink, null);
      assert.equal((await call("/patients/missing", 404, { headers })).error, "patient_not_found");
      assert.equal((await call("/jobs/missing", 404, { headers })).error, "job_not_found");
    });
    await t.test("JSON ingestion rejects invalid input before writing anything", async () => {
      await call("/patients", 200, post({ ID: "7", DOB: "2000-01-01" }));
      await call("/read-aloud", 501, post({ token: "unavailable", language: "en", text: "test" }));
      const cases: [unknown, number, string][] = [
        [{}, 400, "invalid_type"], [{ type: "dictation", patientID: "7", data: "notes" }, 400, "invalid_type"],
        [{ type: "text", data: "notes" }, 400, "missing_patientID"], [{ type: "text", patientID: "7" }, 400, "missing_data"],
        [{ type: "text", patientID: {}, data: "notes" }, 400, "validation_error"],
        [{ type: "text", patientID: "7", data: " \n " }, 400, "empty_input"],
        [{ type: "text", patientID: "missing", data: "notes" }, 404, "patient_not_found"],
        [{ type: "text", patientID: "7", data: "x".repeat(200001) }, 400, "input_too_long"],
        [{ type: "pdf", patientID: "7", data: "invalid-base64" }, 400, "empty_input"],
        [{ type: "pdf", patientID: "7", data: Buffer.from("%PDF-1.4\nnot a document").toString("base64") }, 400, "unreadable_pdf"],
      ];
      for (const [body, status, code] of cases) assert.equal((await call("/ingest", status, post(body))).error, code);
      assert.equal((await call("/ingest", 400, { method: "POST", headers, body: "{" })).error, "invalid_json");
      assert.equal((await h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activeLinks"))?.n, 0);
      assert.equal((await h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs"))?.n, 0);
      assert.equal(h.outbox.length, 0);
    });
    await t.test("multipart rejects ambiguous, empty, invalid and unexpected fields", async () => {
      const send = (form: FormData, code: string) => call("/ingest", 400, { method: "POST", headers: { "x-provider-key": LOCAL_PROVIDER_KEY }, body: form }).then(body => assert.equal(body.error, code));
      let form = new FormData(); form.set("text", "notes"); await send(form, "missing_patientID");
      form = new FormData(); form.set("patientId", "7"); await send(form, "empty_input");
      form = new FormData(); form.set("patientId", "7"); form.set("text", "notes"); form.set("audio", new Blob(["audio"]), "sample.webm"); await send(form, "multiple_inputs");
      form = new FormData(); form.set("patientId", "7"); form.set("file", new Blob(["not PDF"]), "invalid.pdf"); await send(form, "empty_input");
      form = new FormData(); form.set("patientId", "7"); form.set("audio", new Blob([]), "empty.webm"); await send(form, "empty_input");
      form = new FormData(); form.set("patientId", "7"); form.set("unknown", new Blob(["bytes"]), "unknown.bin"); await send(form, "invalid_upload");
    });
    await t.test("text jobs progress from 202/425 to stored notes and a real patient link", async () => {
      text = await call("/ingest", 202, post({ patientID: 7, type: "text", data: "Synthetic API notes: unique-text-291\r\nKeep this source." }));
      assert.match(text.sumId, /^[\w-]{43}$/); assert.equal(text.link, h.origin + "/s/" + text.sumId);
      const pending = await call(`/p/${text.sumId}`, 425); assert.equal(pending.error, "processing");
      await call("/synthesize", 409, post({ sumId: text.sumId }));
      await h.ctx.queue.onIdle();
      const job = await call(`/jobs/${text.jobId}`, 200, { headers });
      assert.equal(job.stage, "done"); assert.equal(job.linkStatus, "ready");
      assert.equal((await h.ctx.summaries.get(text.sumId))?.["raw-text"], "Synthetic API notes: unique-text-291\nKeep this source.");
      assert.equal(h.outbox.length, 2); assert.ok(h.outbox.every(mail => mail.text.includes(text.link)));
      assert.equal((await call("/patients/7", 200, { headers })).activeLink.sumId, text.sumId);
    });
    await t.test("every summary spelling and query alias reads the saved agent response", async () => {
      for (const path of ["/llm-sumary", "/llm-summary", "/summary"]) {
        for (const key of ["sum-id", "sum_id", "sumId", "link", "token"]) {
          const body = await call(`${path}?${key}=${text.sumId}`, 200);
          assert.equal(body.patientID, "7"); assert.equal(body.sumId, text.sumId); assert.equal(body.daysLeft, 30);
          assert.deepEqual(body["llm-summary"], (await h.ctx.summaries.get(text.sumId))?.["llm-summary"]);
        }
        await call(path, 400); await call(`${path}?link=invalid`, 400); await call(`${path}?link=${newSumId()}`, 404);
      }
      await call("/p/invalid", 400); await call(`/p/${newSumId()}`, 404);
      await call(`/p/${text.sumId}`, 200);
      assert.ok((await h.ctx.audit.listForLink(text.sumId)).some(event => event.event === "summary.viewed"));
    });
    await t.test("link login checks DOB, both roles, malformed bodies and unknown tokens", async () => {
      await call("/auth/link", 400, post({ token: text.sumId, dob: "not-a-date", role: "patient" }));
      await call("/auth/link", 400, post({ token: text.sumId, dob: "2000-01-01", role: "doctor" }));
      await call("/auth/link", 401, post({ token: "invalid", dob: "2000-01-01", role: "patient" }));
      await call("/auth/link", 401, post({ token: newSumId(), dob: "2000-01-01", role: "patient" }));
      await call("/auth/link", 401, post({ token: text.sumId, dob: "2001-01-01", role: "patient" }));
      for (const role of ["patient", "caregiver"]) {
        const session = await call("/auth/link", 200, post({ token: text.sumId, dob: "2000-01-01", role }));
        assert.equal(session.role, role); assert.equal(session.patientToken, text.sumId); assert.equal(session.patientId, "7");
        assert.equal(session.providerKey, undefined);
      }
      assert.equal((await call("/auth/link", 200, post({ token: "demo-token-123", dob: "2000-01-01", role: "patient" }))).patientToken, text.sumId);
    });
    await t.test("PDF and audio go through extraction/transcription, storage and the queue", async () => {
      pdf = await call("/ingest", 202, post({ patientID: "8", type: "pdf", data: "data:application/pdf;base64," + pdfBytes().toString("base64") }));
      const form = new FormData(); form.set("patientId", "7"); form.set("audio", new Blob(["synthetic audio bytes"], { type: "audio/webm" }), "sample.webm");
      audio = await call("/ingest", 202, { method: "POST", headers: { "x-provider-key": LOCAL_PROVIDER_KEY }, body: form });
      await h.ctx.queue.onIdle();
      const pdfItem = (await h.ctx.summaries.get(pdf.sumId))!; assert.match(pdfItem["raw-text"]!, /Furosemide/);
      assert.deepEqual((await h.ctx.pdf.get(pdfItem.pdfKey!))?.body, pdfBytes());
      const audioItem = (await h.ctx.summaries.get(audio.sumId))!; assert.equal(audioItem["raw-text"], LOCAL_AUDIO_TRANSCRIPT);
      assert.equal((await h.ctx.audio.get(audioItem.audioKey!))?.body.toString(), "synthetic audio bytes");
      assert.equal(h.outbox.length, 6);
    });
    await t.test("synthesis supports ad-hoc and saved summaries without duplicate email", async () => {
      await call("/synthesize", 400, post({})); await call("/synthesize", 400, post({ sumId: "invalid" }));
      await call("/synthesize", 404, post({ sumId: newSumId() }));
      const adhoc = await call("/synthesize", 200, post({ text: "Synthetic standalone notes" }));
      assert.equal(adhoc.stored, false); assert.match(adhoc["llm-summary"].summary, /Synthetic standalone notes/);
      const saved = await call("/synthesize", 200, post({ linkId: text.sumId }));
      assert.equal(saved.stored, true); assert.equal(saved.emailed, true); assert.equal(h.outbox.length, 6);
    });
    await t.test("both translation routes answer 404 when the stored plan has no translation", async () => {
      for (const path of ["/translation", "/translate"]) assert.equal((await call(`${path}?lang=es&sum_id=${text.sumId}`, 404)).error, "translation_unavailable");
    });
    await t.test("agent failures persist a failed job and send no email", async () => {
      failed = await call("/ingest", 202, post({ patientID: "7", type: "text", data: LOCAL_FAILURE_MARKER }));
      await h.ctx.queue.onIdle();
      const job = await call(`/jobs/${failed.jobId}`, 200, { headers });
      assert.equal(job.stage, "failed"); assert.match(job.error, /Intentional local test/);
      assert.equal((await call(`/p/${failed.sumId}`, 500)).error, "processing_failed");
      assert.equal(h.outbox.length, 6);
    });
    await t.test("expiration and purge remove documents and objects with audit receipts", async () => {
      const pdfKey = (await h.ctx.summaries.get(pdf.sumId))!.pdfKey!;
      const audioKey = (await h.ctx.summaries.get(audio.sumId))!.audioKey!;
      h.ctx.clock.advanceDays(31);
      assert.equal((await call(`/p/${text.sumId}`, 410)).error, "link_expired");
      await call("/synthesize", 410, post({ sumId: text.sumId }));
      const report = await h.ctx.purge();
      assert.equal(report.linksPurged, 4); assert.equal(report.documentsDeleted, 4);
      assert.equal(report.pdfsDeleted, 1); assert.equal(report.audioDeleted, 1); assert.equal(report.receipts.length, 6);
      assert.equal(await h.ctx.summaries.get(text.sumId), null); assert.equal(await h.ctx.pdf.get(pdfKey), null); assert.equal(await h.ctx.audio.get(audioKey), null);
      assert.equal((await call(`/p/${text.sumId}`, 410)).error, "link_purged");
      assert.equal((await h.ctx.receipts.list()).length, 6);
    });
    assert.deepEqual([...exercised].sort(), operations.sort(), "Every documented operation must have a route test");
  } finally { await h.close(); }
});

test("upload limits return 413 for JSON and multipart without creating records", async () => {
  const h = await harness(512);
  try {
    for (const init of [post({ patientID: "7", type: "pdf", data: pdfBytes().toString("base64") }),
      { method: "POST", headers, body: JSON.stringify({ data: "x".repeat(70_000) }) }]) {
      assert.equal((await fetch(h.origin + "/api/ingest", init)).status, 413);
    }
    const form = new FormData(); form.set("patientId", "7"); form.set("audio", new Blob(["x".repeat(513)]), "sample.webm");
    assert.equal((await fetch(h.origin + "/api/ingest", { method: "POST", headers: { "x-provider-key": LOCAL_PROVIDER_KEY }, body: form })).status, 413);
    assert.equal((await h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs"))?.n, 0);
  } finally { await h.close(); }
});

test("the local provider account is disabled outside the local runner", async () => {
  const h = await harness();
  try {
    h.ctx.mode = "aws";
    const response = await fetch(h.origin + "/api/auth/login", post({ email: "rivera@demo.health", password: "demo1234" }));
    assert.equal(response.status, 501); assert.equal((await response.json()).providerKey, undefined);
  } finally { await h.close(); }
});
