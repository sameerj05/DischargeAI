import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalServer } from "../scripts/local-server.js";
import { LOCAL_AUDIO_TRANSCRIPT } from "../scripts/local/context.js";
import { ElevenLabsReadAloud } from "../src/pipeline/readAloud.js";
import { adaptPlan, adaptSummary } from "../../frontend/src/planAdapter.js";
import { speechTextFor } from "../../frontend/src/speechText.js";

const headers = { "Content-Type": "application/json", "x-provider-key": "local-test-key" };
const post = (body: unknown): RequestInit => ({ method: "POST", headers, body: JSON.stringify(body) });
const ingest = (data: string, DOB = "2000-01-01") => post({ patientID: "7", DOB, type: "text", data });

test("registration validates dates, matches identities and refuses a different DOB", async () => {
  const h = await startLocalServer(0);
  try {
    const url = h.origin + "/api/patients";
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    for (const DOB of ["2000-02-30", "2999-01-01", "01/01/2000"]) assert.equal((await fetch(url, post({ ID: "new", DOB }))).status, 400);
    const created = await fetch(url, post({ ID: "new", DOB: "2000-01-01", FirstName: "Synthetic", email: "test@example.test" }));
    assert.equal(created.status, 201); assert.equal((await created.json()).created, true);
    const matched = await fetch(url, post({ ID: "new", DOB: "2000-01-01" }));
    assert.equal(matched.status, 200); assert.equal((await matched.json()).patient.FirstName, "Synthetic");
    assert.equal((await fetch(url, post({ ID: "new", DOB: "2001-01-01" }))).status, 409);
    assert.equal((await h.ctx.patients.getById("new"))?.dateOfBirth, "2000-01-01");
    const parallel = await Promise.all([fetch(url, post({ ID: "race", DOB: "2000-01-01" })), fetch(url, post({ ID: "race", DOB: "2000-01-01" }))]);
    assert.deepEqual(parallel.map(r => r.status).sort(), [200, 201]);
  } finally { await h.close(); }
});

test("updates preserve the original link and expiry, reject busy/DOB mismatch, and start fresh after expiry", async () => {
  const h = await startLocalServer(0);
  try {
    const url = h.origin + "/api/ingest";
    const first = await (await fetch(url, ingest("Original synthetic notes"))).json();
    assert.equal((await fetch(url, ingest("Conflicting update"))).status, 409);
    await h.ctx.queue.onIdle();
    assert.equal((await fetch(url, ingest("Wrong identity", "2001-01-01"))).status, 409);
    h.ctx.clock.advanceDays(29);
    const updated = await (await fetch(url, ingest("Follow-up synthetic notes"))).json();
    assert.equal(updated.appended, true); assert.equal(updated.sumId, first.sumId); assert.equal(updated.expiresAt, first.expiresAt);
    await h.ctx.queue.onIdle();
    const item = (await h.ctx.summaries.get(first.sumId))!;
    assert.match(item["raw-text"]!, /Original synthetic notes[\s\S]*Follow-up synthetic notes/);
    h.ctx.clock.advanceDays(2);
    const next = await (await fetch(url, ingest("New visit after expiry"))).json();
    assert.notEqual(next.sumId, first.sumId); await h.ctx.queue.onIdle();
    assert.equal((await fetch(h.origin + "/api/p/" + first.sumId)).status, 410);
    assert.equal((await h.ctx.summaries.get(next.sumId))?.["raw-text"], "New visit after expiry");
  } finally { await h.close(); }
});

test("recorded audio appends its recognized transcript to prior notes and remains purgeable", async () => {
  const h = await startLocalServer(0);
  try {
    const first = await (await fetch(h.origin + "/api/ingest", ingest("Prior visit"))).json(); await h.ctx.queue.onIdle();
    const form = new FormData(); form.set("patientId", "7"); form.set("DOB", "2000-01-01"); form.set("audio", new Blob(["test audio"], { type: "audio/webm" }), "dictation.webm");
    const response = await fetch(h.origin + "/api/ingest", { method: "POST", headers: { "x-provider-key": "local-test-key" }, body: form });
    assert.equal(response.status, 202); assert.equal((await response.json()).sumId, first.sumId); await h.ctx.queue.onIdle();
    const item = (await h.ctx.summaries.get(first.sumId))!;
    assert.ok(item["raw-text"]!.includes("Prior visit")); assert.ok(item["raw-text"]!.includes(LOCAL_AUDIO_TRANSCRIPT));
    assert.ok(await h.ctx.audio.get(item.audioKey!)); h.ctx.clock.advanceDays(31); await h.ctx.purge();
    assert.equal(await h.ctx.audio.get(item.audioKey!), null);
  } finally { await h.close(); }
});

const agentPlan = {
  why_in_hospital: [{ text: "Synthetic case." }], schedule: { once_daily: [{ medicine: "Test medicine 5 mg", purpose: "Test purpose", note: "" }] },
  new_medicines: [], changed_medicines: [], stopped_medicines: [], tests: [], appointments: [], care_instructions: [{ text: "Rest." }],
  questions_for_care_team: [], call_doctor_if: [], get_help_now_if: [],
};

/** An agent that, like the deployed one, returns the English plan and the translated plans in one response. */
const translatingAgent = {
  name: "test-agent", runtimeArn: "test-agent",
  async invoke(_notes: string, sessionId: string) {
    const en = adaptPlan(agentPlan)!; const es = { ...structuredClone(en), title: "Plan sintético" };
    return { sessionId, latencyMs: 0, response: { result: "# Plan", status: "approved", flags: [], record: { byLang: { en, es } }, translations: { es: { status: "verified", problems: [] } } } };
  },
};

test("translation comes from the agent response, keeps checklist IDs, and read-aloud only accepts displayed sections", async () => {
  const spoken: { text: string; language: string }[] = [];
  const h = await startLocalServer(0, { agent: translatingAgent, readAloud: { name: "test-speech", async synthesize(text, language) { spoken.push({ text, language }); return Buffer.from("test-mp3"); } } });
  try {
    const accepted = await (await fetch(h.origin + "/api/ingest", ingest("Synthetic source"))).json(); await h.ctx.queue.onIdle();
    const english = await (await fetch(h.origin + "/api/p/" + accepted.sumId)).json(); const plan = adaptSummary(english).record.byLang.en!;
    const translateUrl = `${h.origin}/api/translation?sum_id=${accepted.sumId}&lang=es`;
    const response = await fetch(translateUrl); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.translatedPlan.title, "Plan sintético"); assert.equal(result.translationStatus, "verified");
    assert.deepEqual(result.translatedPlan.medications.groups[0].items.map((i: { id: string }) => i.id), plan.medications.groups[0].items.map(i => i.id));
    assert.equal((await fetch(`${h.origin}/api/translation?sum_id=${accepted.sumId}&lang=en`)).status, 200);
    assert.equal((await fetch(`${h.origin}/api/translation?sum_id=${accepted.sumId}&lang=zh`)).status, 404);
    assert.equal((await fetch(`${h.origin}/api/translate?sum_id=${accepted.sumId}&lang=fr`)).status, 400);
    const speak = (text: string, language = "es") => fetch(h.origin + "/api/read-aloud", post({ token: accepted.sumId, language, text }));
    assert.equal((await speak("Arbitrary text unrelated to this patient")).status, 400);
    assert.equal((await speak("Unknown language content", "zh")).status, 409);
    const text = speechTextFor(result.translatedPlan, "es").medsText;
    const audio = await speak(text); assert.equal(audio.status, 200); assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.equal(audio.headers.get("cache-control"), "no-store"); assert.equal(await audio.text(), "test-mp3"); assert.deepEqual(spoken, [{ text, language: "es" }]);
    h.ctx.clock.advanceDays(31); assert.equal((await speak(text)).status, 410); assert.equal((await fetch(translateUrl)).status, 410);
  } finally { await h.close(); }
});

test("a plan without translations answers 404 and speech failures return errors", async () => {
  const h = await startLocalServer(0, { readAloud: { name: "failure", async synthesize() { throw new Error("speech unavailable"); } } });
  try {
    const accepted = await (await fetch(h.origin + "/api/ingest", ingest("Synthetic source"))).json(); await h.ctx.queue.onIdle();
    assert.equal((await fetch(`${h.origin}/api/translation?sum_id=${accepted.sumId}&lang=es`)).status, 404);
    const body = await (await fetch(h.origin + "/api/p/" + accepted.sumId)).json(); const plan = adaptSummary(body).record.byLang.en!;
    assert.equal((await fetch(h.origin + "/api/read-aloud", post({ token: accepted.sumId, language: "en", text: speechTextFor(plan, "en").medsText }))).status, 500);
  } finally { await h.close(); }
});

test("ElevenLabs sends the selected language and server-side key, validates audio and exposes no provider body", async () => {
  const h = await startLocalServer(0);
  try {
    h.ctx.config.ELEVENLABS_API_KEY = "UNIT_TEST_KEY";
    let calls = 0;
    const provider = new ElevenLabsReadAloud(h.ctx.config, (async (url, init) => {
      calls++; assert.ok(String(url).includes("/text-to-speech/")); assert.equal((init!.headers as Record<string, string>)["xi-api-key"], "UNIT_TEST_KEY");
      assert.deepEqual(JSON.parse(init!.body as string), { text: "Synthetic text", model_id: "eleven_multilingual_v2", language_code: "ar" });
      return new Response("audio", { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch);
    assert.equal((await provider.synthesize("Synthetic text", "ar")).toString(), "audio"); assert.equal(calls, 1);
    const denied = new ElevenLabsReadAloud(h.ctx.config, (async () => new Response("private provider detail", { status: 401 })) as typeof fetch);
    await assert.rejects(denied.synthesize("x", "en"), /^Error: ElevenLabs returned HTTP 401$/);
    const nonAudio = new ElevenLabsReadAloud(h.ctx.config, (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch);
    await assert.rejects(nonAudio.synthesize("x", "en"), /non-audio/);
  } finally { await h.close(); }
});
