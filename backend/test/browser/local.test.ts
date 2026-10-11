import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { startLocalServer } from "../../scripts/local-server.js";
import { LOCAL_AUDIO_TRANSCRIPT, LOCAL_FAILURE_MARKER } from "../../scripts/local/context.js";

test("the original design works through real HTTP for login, text/PDF/live dictation, both roles, failures and expiry", { timeout: 120_000 }, async () => {
  const local = await startLocalServer(0);
  let browser;
  const errors: string[] = [];
  const externalRequests: string[] = [];
  try {
    const edge = process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
    browser = await chromium.launch({ ...(edge ? { channel: "msedge" } : {}), headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
    const context = await browser.newContext({ viewport: { width: 790, height: 1044 }, permissions: ["microphone"] });
    context.on("request", request => {
      if (["fetch", "xhr"].includes(request.resourceType()) && new URL(request.url()).origin !== local.origin) externalRequests.push(request.url());
    });
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    // No intercepted API responses: the browser reaches the real backend and SQLite repositories.
    const page = await context.newPage();
    await page.goto(local.origin);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await page.getByRole("tab").count(), 3);
    assert.equal(await page.locator(".login-card").count(), 1);
    const artifacts = join(import.meta.dirname, "../../../.tools"); mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "connected-login.png"), fullPage: true });
    await page.getByLabel("Email", { exact: true }).fill("rivera@demo.health");
    await page.getByLabel("Password", { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("alert").waitFor();
    await page.getByLabel("Password", { exact: true }).fill("demo1234");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "Create visit writeup", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Alex Example", exact: true }).waitFor();
    assert.equal(await page.locator(".stat-card").count(), 4);
    assert.equal(await page.locator(".composer-card").count(), 1);
    await page.screenshot({ path: join(artifacts, "connected-dashboard.png"), fullPage: true });
    assert.equal(await page.evaluate(() => sessionStorage.getItem("dai.session")!.includes("providerKey")), false);

    const submit = async () => {
      const accepted = page.waitForResponse(response => response.url() === local.origin + "/api/ingest" && response.request().method() === "POST");
      await page.getByRole("button", { name: "Send writeup", exact: true }).click();
      const response = await accepted; assert.equal(response.status(), 202);
      const value = await response.json();
      await page.getByText("Plan ready. Open the patient link below.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "Open patient plan", exact: true }).getAttribute("href"), value.link);
      return value as { sumId: string; link: string };
    };
    const openPlan = async (link: string, role: "Patient" | "Caregiver") => {
      const viewer = await context.newPage();
      await viewer.goto(link);
      await viewer.getByRole("tab", { name: role, exact: true }).click();
      if (role === "Caregiver") await viewer.getByLabel("Patient's date of birth", { exact: true }).fill("2000-01-01");
      else await viewer.getByLabel("Confirm your date of birth", { exact: true }).fill("2000-01-01");
      await viewer.getByRole("button", { name: "Sign in", exact: true }).click();
      await viewer.getByRole("heading", { name: "Your Going-Home Plan", exact: true }).waitFor();
      return viewer;
    };
    const notes = "Synthetic browser case: unique-note-713. Follow the example instructions.";
    await page.getByLabel("Visit writeup", { exact: true }).fill(notes);
    const text = await submit();
    const patient = await openPlan(text.link, "Patient");
    const task = patient.getByRole("button", { name: `Submitted notes: ${notes}`, exact: true });
    await task.waitFor(); await task.click(); assert.equal(await task.getAttribute("aria-pressed"), "true");
    await patient.getByText("Local test fixture. No AI generation or clinical review was performed.", { exact: true }).waitFor();
    await patient.reload();
    await patient.getByRole("button", { name: `Submitted notes: ${notes}`, exact: true }).waitFor();
    assert.equal(await patient.getByRole("button", { name: `Submitted notes: ${notes}`, exact: true }).getAttribute("aria-pressed"), "true");
    const caregiver = await openPlan(text.link, "Caregiver");
    await caregiver.getByRole("button", { name: `Submitted notes: ${notes}`, exact: true }).waitFor();
    assert.equal((await local.ctx.summaries.get(text.sumId))?.["raw-text"], notes);
    assert.equal(local.outbox.length, 2); assert.ok(local.outbox.every(mail => mail.text.includes(text.link)));
    await patient.screenshot({ path: join(artifacts, "connected-patient.png"), fullPage: true });
    await caregiver.screenshot({ path: join(artifacts, "connected-caregiver.png"), fullPage: true });

    await page.locator(".patient-nav-item").filter({ hasText: "Jordan Sample" }).click();
    assert.equal(await page.getByLabel("Visit writeup", { exact: true }).inputValue(), "");
    await page.locator(".patient-nav-item").filter({ hasText: "Alex Example" }).click();
    assert.equal(await page.getByLabel("Visit writeup", { exact: true }).inputValue(), notes);
    await page.getByLabel("Visit writeup", { exact: true }).fill("");
    const bytes = process.env.PRACTICE_PDF ? readFileSync(process.env.PRACTICE_PDF) : readFileSync(join(import.meta.dirname, "../fixtures/synthetic-discharge.pdf"));
    await page.locator("input[type=file]").setInputFiles({ name: "practice.pdf", mimeType: "application/pdf", buffer: bytes });
    await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement)?.value.includes("Furosemide"));
    const pdf = await submit();
    assert.equal(pdf.sumId, text.sumId, "PDF notes append to the existing 30-day plan");
    const pdfItem = (await local.ctx.summaries.get(pdf.sumId))!;
    assert.equal(pdfItem.inputKind, "pdf"); assert.match(pdfItem["raw-text"]!, /Furosemide/);
    assert.deepEqual((await local.ctx.pdf.get(pdfItem.pdfKey!))?.body, bytes);
    const pdfViewer = await openPlan(pdf.link, "Patient");
    await pdfViewer.getByRole("button", { name: /Submitted notes:[\s\S]*Furosemide/ }).waitFor();

    await page.getByLabel("Visit writeup", { exact: true }).fill("");
    await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    await page.getByRole("button", { name: "Stop dictation", exact: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement)?.value === "Synthetic audio transcript");
    assert.equal(await page.getByRole("button", { name: "Send writeup", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement)?.value.includes("fixed fixture"));
    await page.getByRole("button", { name: "Send writeup", exact: true }).waitFor({ state: "visible" });
    await page.locator(".patient-nav-item").filter({ hasText: "Jordan Sample" }).click();
    assert.equal(await page.getByLabel("Visit writeup", { exact: true }).inputValue(), "");
    await page.locator(".patient-nav-item").filter({ hasText: "Alex Example" }).click();
    assert.equal(await page.getByLabel("Visit writeup", { exact: true }).inputValue(), LOCAL_AUDIO_TRANSCRIPT);
    const audio = await submit();
    const audioItem = (await local.ctx.summaries.get(audio.sumId))!;
    assert.equal(audio.sumId, text.sumId); assert.ok(audioItem["raw-text"]!.includes(notes));
    assert.ok(audioItem["raw-text"]!.includes(LOCAL_AUDIO_TRANSCRIPT)); assert.equal(audioItem.inputKind, "text");
    const audioViewer = await openPlan(audio.link, "Patient");
    await audioViewer.getByRole("button", { name: new RegExp(`Submitted notes:[\\s\\S]*${LOCAL_AUDIO_TRANSCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).waitFor();
    assert.equal((await local.ctx.jobs.latestForLink(audio.sumId))?.inputKind, "text");

    // Unsupported translation must not silently display a hardcoded translated plan.
    await patient.getByRole("button", { name: /English/ }).click();
    await patient.getByRole("option", { name: /Español/ }).click();
    await patient.getByRole("alert").filter({ hasText: "Translation is not configured" }).waitFor();
    await page.getByLabel("Visit writeup", { exact: true }).fill(LOCAL_FAILURE_MARKER);
    await page.getByRole("button", { name: "Send writeup", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Intentional local test agent failure" }).waitFor();
    assert.equal(local.outbox.length, 6);
    const docs = await context.newPage(); await docs.goto(local.origin + "/api/docs/");
    await docs.locator(".opblock").first().waitFor(); assert.equal(await docs.locator(".opblock").count(), 16);
    local.ctx.clock.advanceDays(31);
    const report = await local.ctx.purge(); assert.equal(report.linksPurged, 1); assert.equal(report.receipts.length, 2);
    await caregiver.reload();
    await caregiver.getByRole("alert").filter({ hasText: /permanently deleted/ }).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, [], "Application API requests stay on the local server");
  } finally { await browser?.close(); await local.close(); }
});

test("read-aloud shows loading, recovers from blocked playback through native controls, and stops cleanly", { timeout: 60_000 }, async () => {
  const mp3 = readFileSync(join(import.meta.dirname, "../fixtures/synthetic-audio.mp3"));
  let calls = 0;
  const local = await startLocalServer(0, { readAloud: { name: "synthetic-audio-test", async synthesize() {
    calls++; await new Promise(resolve => setTimeout(resolve, 1500)); return mp3;
  } } });
  const edge = process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
  const browser = await chromium.launch({ ...(edge ? { channel: "msedge" } : {}), headless: true });
  try {
    const response = await fetch(local.origin + "/api/ingest", { method: "POST", headers: { "Content-Type": "application/json", "x-provider-key": "local-test-key" }, body: JSON.stringify({ patientID: "7", DOB: "2000-01-01", type: "text", data: "Synthetic audio interface test." }) });
    assert.equal(response.status, 202); const accepted = await response.json();
    for (let i = 0; i < 100 && (await local.ctx.jobs.get(accepted.jobId))?.stage !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const original = HTMLMediaElement.prototype.play; let blocked = false;
      HTMLMediaElement.prototype.play = function () {
        if (!blocked) { blocked = true; return Promise.reject(new DOMException("User gesture required", "NotAllowedError")); }
        return original.call(this);
      };
    });
    await page.goto(accepted.link); await page.getByRole("tab", { name: "Patient", exact: true }).click();
    await page.getByLabel("Confirm your date of birth", { exact: true }).fill("2000-01-01");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const speaker = page.locator(".read-aloud-btn").nth(1); const player = page.locator("audio");
    assert.equal(await player.isVisible(), false);
    await speaker.click(); await page.getByRole("status").filter({ hasText: "Preparing audio" }).waitFor();
    await page.getByRole("alert").filter({ hasText: "Your browser blocked playback" }).waitFor();
    assert.equal(await player.isVisible(), true);
    const box = await player.boundingBox(); assert.ok(box);
    await page.mouse.click(box.x + 25, box.y + box.height / 2);
    await page.waitForFunction(() => { const audio = document.querySelector("audio")!; return !audio.paused && audio.readyState >= 2 && audio.currentTime > 0.1; });
    assert.equal(await page.getByRole("alert").filter({ hasText: "Your browser blocked playback" }).count(), 0);
    assert.equal(calls, 1, "Native Play uses the already generated audio");
    await speaker.click(); assert.equal(await player.isVisible(), false);
    assert.equal(await player.evaluate(audio => (audio as HTMLAudioElement).paused), true);
    await speaker.click(); await page.getByRole("status").filter({ hasText: "Preparing audio" }).waitFor();
    await speaker.click(); await page.waitForTimeout(1800);
    assert.equal(await player.isVisible(), false); assert.equal(await player.getAttribute("src"), null);
  } finally { await browser.close(); await local.close(); }
});

test("live dictation preserves drafts, recovers from microphone/provider failures and stops on patient changes", { timeout: 90_000 }, async () => {
  let attempts = 0;
  const local = await startLocalServer(0, { liveDictation: { name: "synthetic-stream-test", async *transcribe(audio) {
    const attempt = ++attempts; let frames = 0;
    for await (const frame of audio) {
      assert.ok(frame.length > 0 && frame.length % 2 === 0);
      if (attempt === 1) throw Object.assign(new Error("test provider denial"), { name: "AccessDeniedException" });
      if (++frames === 1) yield { id: "a", text: "Take four", partial: true };
      if (frames === 3) yield { id: "a", text: "Take furosemide 40 mg", partial: true };
    }
    yield { id: "a", text: "Take furosemide 40 mg once daily.", partial: false };
    yield { id: "a", text: "Take furosemide 40 mg once daily.", partial: false };
  } } });
  const edge = process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
  const browser = await chromium.launch({ ...(edge ? { channel: "msedge" } : {}), headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    const context = await browser.newContext({ permissions: ["microphone"] });
    await context.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const state = window as unknown as { dictationTracks: MediaStreamTrack[]; denyMic: boolean };
      state.dictationTracks = []; state.denyMic = true;
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (state.denyMic) { state.denyMic = false; throw new DOMException("test denial", "NotAllowedError"); }
        const stream = await original(constraints); state.dictationTracks.push(...stream.getTracks()); return stream;
      };
    });
    const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(local.origin);
    await page.getByLabel("Email", { exact: true }).fill("rivera@demo.health"); await page.getByLabel("Password", { exact: true }).fill("demo1234");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "Alex Example", exact: true }).waitFor();
    const input = page.getByLabel("Visit writeup", { exact: true });
    await input.fill("Existing typed notes.");
    await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Microphone access was denied" }).waitFor();
    assert.equal(await input.inputValue(), "Existing typed notes."); assert.equal(attempts, 0);
    await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "transcribe:StartMedicalStreamTranscription" }).waitFor();
    assert.equal(await input.inputValue(), "Existing typed notes.");
    await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea")!.value === "Existing typed notes.\n\nTake furosemide 40 mg");
    assert.equal(await page.getByRole("button", { name: "Send writeup", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea")!.value === "Existing typed notes.\n\nTake furosemide 40 mg once daily." && !document.querySelector("textarea")!.readOnly);
    assert.equal(await page.evaluate(() => (window as unknown as { dictationTracks: MediaStreamTrack[] }).dictationTracks.every(track => track.readyState === "ended")), true);
    await input.fill("Reviewed notes. Follow up in one week.");
    await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea")!.value === "Reviewed notes. Follow up in one week.\n\nTake furosemide 40 mg");
    await page.locator(".patient-nav-item").filter({ hasText: "Jordan Sample" }).click();
    await page.waitForFunction(() => !document.querySelector("textarea")!.readOnly);
    assert.equal(await input.inputValue(), "");
    await page.waitForTimeout(300); assert.equal(await input.inputValue(), "", "Old transcript events cannot modify another patient's draft");
    assert.equal(await page.evaluate(() => (window as unknown as { dictationTracks: MediaStreamTrack[] }).dictationTracks.every(track => track.readyState === "ended")), true);
    await page.locator(".patient-nav-item").filter({ hasText: "Alex Example" }).click();
    assert.equal(await input.inputValue(), "Reviewed notes. Follow up in one week.\n\nTake furosemide 40 mg");
    await input.fill("Reviewed final dictation text.");
    const submitted = page.waitForResponse(response => response.url() === local.origin + "/api/ingest" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send writeup", exact: true }).click();
    const response = await submitted;
    assert.equal(response.status(), 202); assert.equal(response.request().postDataJSON().data, "Reviewed final dictation text.");
    await page.getByText("Plan ready. Open the patient link below.", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await local.close(); }
});
