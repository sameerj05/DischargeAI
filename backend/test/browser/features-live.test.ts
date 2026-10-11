import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { adaptSummary } from "../../../frontend/src/planAdapter.js";
import type { DischargePlan } from "../../../frontend/src/data.js";

// Opt-in: real provider calls, synthetic data only. Start npm run local:ai first.
test("live browser: registration, 30-day append, streaming microphone dictation, translated plans and ElevenLabs playback", { timeout: 40 * 60_000 }, async () => {
  const origin = process.env.LIVE_APP_URL ?? "http://127.0.0.1:4000";
  const artifacts = resolve(import.meta.dirname, "../../../.tools"); mkdirSync(artifacts, { recursive: true });
  const wav = process.env.LIVE_TEST_AUDIO ?? join(artifacts, "healthscribe-test.wav");
  assert.ok(existsSync(wav), "Set LIVE_TEST_AUDIO to a synthetic WAV conversation for the fake microphone");
  const health = await (await fetch(origin + "/api/health")).json();
  assert.equal(health.mode, "local-agentcore"); assert.deepEqual(health.capabilities, { liveAi: true, dictation: true, translation: true, readAloud: true });
  const edge = process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
  const browser = await chromium.launch({ ...(edge ? { channel: "msedge" } : {}), headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
  const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), syntheticData: true, runtimeArn: health.providers.agentRuntimeArn, languages: [] };
  try {
    const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1365, height: 900 } });
    const errors: string[] = []; const externalRequests: string[] = [];
    context.on("request", r => { if (["fetch", "xhr"].includes(r.resourceType()) && new URL(r.url()).origin !== origin) externalRequests.push(r.url()); });
    context.on("page", page => page.on("pageerror", e => errors.push(e.message)));
    await context.addInitScript(() => {
      const original = HTMLMediaElement.prototype.play;
      const state = window as unknown as { testAudio: HTMLMediaElement[] }; state.testAudio = [];
      HTMLMediaElement.prototype.play = function () {
        state.testAudio.push(this); const promise = original.call(this);
        void promise.then(() => { this.dataset.testPlayed = "true"; }).catch(() => {}); return promise;
      };
    });
    const doctor = await context.newPage(); await doctor.goto(origin);
    await doctor.getByLabel("Email", { exact: true }).fill("rivera@demo.health"); await doctor.getByLabel("Password", { exact: true }).fill("demo1234");
    await doctor.getByRole("button", { name: "Sign in", exact: true }).click(); await doctor.getByRole("heading", { name: "Create visit writeup", exact: true }).waitFor();
    const ID = `live-${Date.now()}`;
    await doctor.getByRole("button", { name: "Register patient", exact: true }).click();
    await doctor.getByLabel("Patient ID", { exact: true }).fill(ID); await doctor.getByLabel("Date of birth", { exact: true }).fill("2000-01-01");
    await doctor.getByLabel("First name", { exact: true }).fill("Synthetic"); await doctor.getByLabel("Last name", { exact: true }).fill("Workflow");
    const registration = doctor.waitForResponse(r => r.url() === origin + "/api/patients" && r.request().method() === "POST");
    await doctor.getByRole("button", { name: "Save patient", exact: true }).click(); assert.equal((await registration).status(), 201);
    await doctor.getByRole("heading", { name: "Synthetic Workflow", exact: true }).waitFor();
    const submit = async (kind: "text") => {
      console.log(JSON.stringify({ phase: "submit", kind })); const started = Date.now();
      const acceptedPromise = doctor.waitForResponse(r => r.url() === origin + "/api/ingest" && r.request().method() === "POST");
      await doctor.getByRole("button", { name: "Send writeup", exact: true }).click(); const response = await acceptedPromise; assert.equal(response.status(), 202);
      const accepted = await response.json(); await doctor.getByText("Plan ready. Open the patient link below.", { exact: true }).waitFor({ timeout: 31 * 60_000 });
      const job = await (await fetch(`${origin}/api/jobs/${accepted.jobId}`, { headers: { "x-provider-key": "local-test-key" } })).json();
      assert.equal(job.stage, "done"); assert.equal(job.inputKind, kind); assert.equal(job.meta.provider, "agentcore");
      console.log(JSON.stringify({ phase: "completed", kind, latencyMs: Date.now() - started, sourceChars: job.meta.sourceChars }));
      return { accepted, job };
    };
    await doctor.getByLabel("Visit writeup", { exact: true }).fill("Synthetic application test. Discharged after treatment for swelling. Continue Furosemide 40 mg by mouth once daily. Check potassium in 1 week. Cardiology follow-up in 1 week. Weigh yourself every morning. Seek emergency help for chest pain or trouble breathing.");
    const first = await submit("text"); report.registration = true; report.patientLink = first.accepted.link;
    await doctor.getByRole("button", { name: "Register patient", exact: true }).click();
    const matchPromise = doctor.waitForResponse(r => r.url() === origin + "/api/patients" && r.request().method() === "POST");
    await doctor.getByRole("button", { name: "Save patient", exact: true }).click(); const matched = await matchPromise; assert.equal(matched.status(), 200); assert.equal((await matched.json()).created, false);
    await doctor.getByLabel("Visit writeup", { exact: true }).fill("");
    await doctor.getByRole("button", { name: "Start dictation", exact: true }).click(); await doctor.getByRole("button", { name: "Stop dictation", exact: true }).waitFor();
    console.log(JSON.stringify({ phase: "recording synthetic microphone", seconds: 35 }));
    await doctor.waitForTimeout(35_000);
    assert.match(await doctor.getByLabel("Visit writeup", { exact: true }).inputValue(), /furosemide/i);
    await doctor.getByRole("button", { name: "Stop dictation", exact: true }).click();
    await doctor.waitForFunction(() => !document.querySelector("textarea")!.readOnly);
    const appended = await submit("text"); assert.equal(appended.accepted.sumId, first.accepted.sumId); assert.equal(appended.accepted.expiresAt, first.accepted.expiresAt); assert.equal(appended.accepted.appended, true);
    report.append = { sameLink: true, originalExpiry: first.accepted.expiresAt, speechProvider: health.providers.liveDictation, sourceChars: appended.job.meta.sourceChars };
    const englishBody = await (await fetch(`${origin}/api/p/${first.accepted.sumId}`)).json(); const english = adaptSummary(englishBody).record.byLang.en!; assert.ok(english);
    const patient = await context.newPage(); await patient.goto(first.accepted.link);
    await patient.getByRole("tab", { name: "Patient", exact: true }).click(); await patient.getByLabel("Confirm your date of birth", { exact: true }).fill("2000-01-01");
    await patient.getByRole("button", { name: "Sign in", exact: true }).click(); await patient.getByRole("heading", { name: english.title, exact: true }).waitFor();
    const tracked = patient.locator(".track-item").first(); await tracked.click(); assert.equal(await tracked.getAttribute("aria-pressed"), "true");
    const ids = (plan: DischargePlan) => [...plan.medications.groups.flatMap(g => g.items.map(i => i.id)), ...plan.todos.labs.map(i => i.id), ...plan.todos.appointments.map(i => i.id), ...plan.todos.careInstructions.map(i => i.id)];
    const languages: unknown[] = [];
    for (const [lang, label] of [["en", "English"], ["es", "Spanish"], ["zh", "Chinese"], ["ar", "Arabic"]] as const) {
      console.log(JSON.stringify({ phase: "translation and playback", language: lang }));
      if (lang !== "en") {
        await patient.locator(".lang-picker-trigger").click(); const translated = patient.waitForResponse(r => r.url().includes("/api/translation?") && new URL(r.url()).searchParams.get("lang") === lang, { timeout: 16 * 60_000 });
        await patient.getByRole("option").filter({ hasText: label }).click(); const response = await translated; assert.equal(response.status(), 200);
        const body = await response.json(); assert.ok(["verified", "needs_review"].includes(body.translationStatus)); assert.deepEqual(ids(body.translatedPlan), ids(english));
        await patient.getByRole("heading", { name: body.translatedPlan.title, exact: true }).waitFor(); assert.equal(await patient.locator(".track-item").first().getAttribute("aria-pressed"), "true");
        if (lang === "ar") assert.ok(await patient.locator('[dir="rtl"]').count());
        languages.push({ language: lang, translationStatus: body.translationStatus, checklistIdsPreserved: true });
      } else languages.push({ language: lang });
      const audioPromise = patient.waitForResponse(r => r.url() === origin + "/api/read-aloud" && r.request().method() === "POST", { timeout: 120_000 });
      await patient.locator(".read-aloud-btn").nth(1).click(); const audio = await audioPromise; assert.equal(audio.status(), 200);
      assert.ok(Number(audio.headers()["content-length"]) > 1000);
      assert.equal(audio.headers()["content-type"], "audio/mpeg"); assert.equal(JSON.parse(audio.request().postData()!).language, lang);
      await patient.waitForFunction(() => (window as unknown as { testAudio: HTMLMediaElement[] }).testAudio.some(a => !a.paused && a.readyState >= 2 && a.dataset.testPlayed === "true"), { timeout: 30_000 });
      // Edge's devtools can elide audio response bodies. Verify the actual browser Blob instead.
      const blobSize = await patient.evaluate(async () => {
        const audios = (window as unknown as { testAudio: HTMLMediaElement[] }).testAudio;
        return (await (await fetch(audios[audios.length - 1].src)).blob()).size;
      });
      assert.ok(blobSize > 1000);
      await patient.locator(".read-aloud-btn").nth(1).click();
      await patient.screenshot({ path: join(artifacts, `features-${lang}-patient.png`), fullPage: true });
    }
    const caregiver = await context.newPage(); await caregiver.goto(first.accepted.link); await caregiver.getByRole("tab", { name: "Caregiver", exact: true }).click();
    await caregiver.getByLabel("Patient's date of birth", { exact: true }).fill("2000-01-01"); await caregiver.getByRole("button", { name: "Sign in", exact: true }).click();
    await caregiver.getByText(english.medications.groups[0].items[0].name, { exact: true }).first().waitFor();
    const docs = await context.newPage(); await docs.goto(origin + "/api/docs/"); await docs.locator(".opblock").first().waitFor(); assert.equal(await docs.locator(".opblock").count(), 16);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    Object.assign(report, { passed: true, languages, patientLink: first.accepted.link, browserAudioPlayback: true, caregiver: true, swaggerOperations: 16, clinicalCorrectnessVerified: false });
  } catch (error) { Object.assign(report, { passed: false, error: String(error) }); throw error; }
  finally { writeFileSync(join(artifacts, "features-live-report.json"), JSON.stringify(report, null, 2)); await browser.close(); }
});
