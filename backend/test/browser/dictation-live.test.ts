import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { startLocalServer } from "../../scripts/local-server.js";
import { loadConfig } from "../../src/config.js";
import { MedicalLiveDictation } from "../../src/pipeline/liveDictation.js";

// Explicit opt-in: real AWS speech, synthetic microphone, isolated app storage and fixture plan agent.
test("LIVE medical dictation updates the writeup while speaking and retains editable final text", { timeout: 120_000 }, async () => {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const artifacts = resolve(import.meta.dirname, "../../../.tools"); mkdirSync(artifacts, { recursive: true });
  const wav = process.env.LIVE_TEST_AUDIO ?? join(artifacts, "healthscribe-test.wav");
  assert.ok(existsSync(wav), "Set LIVE_TEST_AUDIO to a synthetic English PCM WAV for the fake microphone");
  const local = await startLocalServer(0, { liveDictation: new MedicalLiveDictation(config.TRANSCRIBE_STREAMING_REGION) });
  let browser;
  try {
    const edge = process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
    browser = await chromium.launch({ ...(edge ? { channel: "msedge" } : {}), headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(local.origin);
    await page.getByLabel("Email", { exact: true }).fill("rivera@demo.health"); await page.getByLabel("Password", { exact: true }).fill("demo1234");
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("heading", { name: "Alex Example", exact: true }).waitFor();
    const input = page.getByLabel("Visit writeup", { exact: true }); const prefix = "Synthetic live dictation test.";
    await input.fill(prefix);
    await page.evaluate(() => {
      const state = window as unknown as { dictationUpdates: string[] }; state.dictationUpdates = [];
      setInterval(() => {
        const text = document.querySelector("textarea")?.value;
        if (text && state.dictationUpdates.at(-1) !== text) state.dictationUpdates.push(text);
      }, 100);
    });
    const started = Date.now();
    await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    await page.getByRole("button", { name: "Stop dictation", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector("textarea")!.value.includes("\n\n") || document.querySelector(".transcript-error[role=alert]"), { timeout: 30_000 });
    const alert = page.locator(".transcript-error[role=alert]");
    assert.equal(await alert.count(), 0, await alert.allTextContents().then(values => values.join(" ")));
    const firstPartialMs = Date.now() - started;
    assert.equal(await page.getByRole("button", { name: "Stop dictation", exact: true }).isVisible(), true);
    await page.waitForTimeout(Math.max(0, 35_000 - (Date.now() - started)));
    const whileRecording = await input.inputValue();
    assert.ok(whileRecording.startsWith(prefix + "\n\n")); assert.ok(whileRecording.length > prefix.length + 30);
    await page.screenshot({ path: join(artifacts, "dictation-live-recording.png"), fullPage: true });
    await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("textarea")!.readOnly, { timeout: 25_000 });
    assert.equal(await alert.count(), 0, await alert.allTextContents().then(values => values.join(" ")));
    const final = await input.inputValue(); assert.match(final, /furosemide/i);
    const updates = await page.evaluate(() => (window as unknown as { dictationUpdates: string[] }).dictationUpdates.length);
    assert.ok(updates > 2, "Real AWS partial results update the textarea repeatedly");
    await input.fill(final + "\nReviewed."); assert.ok((await input.inputValue()).endsWith("Reviewed."));
    assert.deepEqual(errors, []);
    const report = { verifiedAt: new Date().toISOString(), provider: "transcribe-medical-streaming", region: config.TRANSCRIBE_STREAMING_REGION,
      syntheticData: true, firstPartialMs, textareaUpdates: updates, finalCharacters: final.length, whileRecordingVerified: true, editableAfterStop: true };
    writeFileSync(join(artifacts, "dictation-live-report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await browser?.close(); await local.close(); }
});
