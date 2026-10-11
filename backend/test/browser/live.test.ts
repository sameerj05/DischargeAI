import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { startLocalServer } from "../../scripts/local-server.js";
import { createLocalLiveAgent } from "../../scripts/local/agentcore.js";
import { pdfToText } from "../../src/extract/pdfToText.js";
import { adaptSummary } from "../../../frontend/src/planAdapter.js";
import type { SummaryResponse } from "../../../frontend/src/api.js";

test("LIVE AgentCore responds through local HTTP/storage and the original patient/caregiver UI", { timeout: 20 * 60_000 }, async () => {
  const external = process.env.LIVE_TEST_ORIGIN;
  if (external && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(external)) throw new Error("LIVE_TEST_ORIGIN must be a loopback HTTP origin");
  const agent = external ? undefined : createLocalLiveAgent();
  const owned = agent ? await startLocalServer(0, { agent }) : undefined;
  const origin = external ?? owned!.origin;
  let browser;
  const errors: string[] = [];
  const cases: Record<string, unknown>[] = [];
  const artifacts = join(import.meta.dirname, "../../../.tools"); mkdirSync(artifacts, { recursive: true });
  const providerHeaders = { "x-provider-key": "local-test-key" };
  try {
    const health = await (await fetch(origin + "/api/health")).json();
    assert.equal(health.mode, "local-agentcore"); assert.equal(health.providers.llm, "agentcore");
    if (process.env.AGENT_RUNTIME_ARN) assert.equal(health.providers.agentRuntimeArn, process.env.AGENT_RUNTIME_ARN);
    assert.ok(["memory", "sqlite"].includes(health.providers.docStore));
    if (owned) assert.equal(health.providers.speech, "unavailable");
    let notes = "Synthetic practice case. Heart failure. New medication: furosemide 40 mg once daily. Stop lisinopril. Follow up with cardiology within 1 week. Check creatinine and potassium.";
    if (process.env.PRACTICE_PDF) {
      const extracted = (await pdfToText(readFileSync(process.env.PRACTICE_PDF))).text;
      const first = extracted.match(/^Example\s+1\s*[—–-]/m);
      const second = extracted.match(/^Example\s+2\s*[—–-]/m);
      assert.ok(first && second && second.index! > first.index!, "Example 1 and 2 boundaries are required; refusing to send the whole PDF");
      notes = extracted.slice(first.index!, second.index!).trim();
      assert.doesNotMatch(notes, /^Example\s+[2-9]\s*[—–-]/m);
    }
    const edge = process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
    browser = await chromium.launch({ ...(edge ? { channel: "msedge" } : {}), headless: true });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    const externalRequests: string[] = [];
    context.on("request", request => {
      if (["fetch", "xhr"].includes(request.resourceType()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url());
    });
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    const doctor = await context.newPage(); await doctor.goto(origin);
    await doctor.getByLabel("Email", { exact: true }).fill("rivera@demo.health");
    await doctor.getByLabel("Password", { exact: true }).fill("demo1234");
    await doctor.getByRole("button", { name: "Sign in", exact: true }).click();
    await doctor.getByRole("heading", { name: "Alex Example", exact: true }).waitFor();
    await doctor.getByText(/Live AI · local storage · test emails captured locally/).waitFor();
    assert.equal(await doctor.getByRole("button", { name: "Start dictation", exact: true }).isDisabled(), !health.capabilities.dictation);
    const submit = async (kind: "text" | "pdf") => {
      console.log(JSON.stringify({ check: "live-browser", inputKind: kind, phase: "submitting" }));
      const started = Date.now();
      const responsePromise = doctor.waitForResponse(response => response.url() === origin + "/api/ingest" && response.request().method() === "POST");
      await doctor.getByRole("button", { name: "Send writeup", exact: true }).click();
      const acceptedResponse = await responsePromise; assert.equal(acceptedResponse.status(), 202);
      const accepted = await acceptedResponse.json();
      await doctor.getByText("Plan ready. Open the patient link below.", { exact: true }).waitFor({ timeout: 16 * 60_000 });
      assert.equal(await doctor.getByRole("link", { name: "Open patient plan", exact: true }).getAttribute("href"), accepted.link);
      const job = await (await fetch(`${origin}/api/jobs/${accepted.jobId}`, { headers: providerHeaders })).json();
      assert.equal(job.stage, "done"); assert.equal(job.inputKind, kind); assert.equal(job.meta.provider, "agentcore");
      assert.equal(job.meta.agentRuntimeArn, health.providers.agentRuntimeArn);
      const summaryResponse = await fetch(`${origin}/api/p/${accepted.sumId}`); assert.equal(summaryResponse.status, 200);
      const summary = await summaryResponse.json() as SummaryResponse;
      const adapted = adaptSummary(summary);
      assert.ok(adapted.summary.trim() || adapted.record.byLang.en, "The live agent returned usable output");
      assert.doesNotMatch(JSON.stringify(summary["llm-summary"]), /Sample medication \(test fixture\)|Local test fixture/);
      assert.match(JSON.stringify(summary["llm-summary"]), /furosemide/i, "The response must relate to this submitted case");
      const viewers = [];
      for (const role of ["Patient", "Caregiver"] as const) {
        const viewer = await context.newPage(); await viewer.goto(accepted.link);
        await viewer.getByRole("tab", { name: role, exact: true }).click();
        await viewer.getByLabel(role === "Patient" ? "Confirm your date of birth" : "Patient's date of birth", { exact: true }).fill("2000-01-01");
        await viewer.getByRole("button", { name: "Sign in", exact: true }).click();
        await viewer.getByText(`Review status: ${adapted.status}`, { exact: true }).waitFor();
        if (adapted.record.byLang.en) {
          const plan = adapted.record.byLang.en;
          for (const med of plan.medications.groups.flatMap(group => group.items)) await viewer.getByText(med.name, { exact: true }).first().waitFor();
          for (const item of [...plan.todos.labs, ...plan.todos.appointments, ...plan.todos.careInstructions]) await viewer.getByText(item.label, { exact: true }).first().waitFor();
          for (const item of [...plan.newMedicines, ...plan.stoppedMedicines]) {
            await viewer.getByText(item.name, { exact: true }).first().waitFor();
            if (item.detail) await viewer.getByText(item.detail, { exact: true }).first().waitFor();
          }
          for (const warning of plan.warningSigns.signs) await viewer.getByText(warning, { exact: true }).first().waitFor();
        } else {
          const rendered = viewer.locator(role === "Patient" ? ".patient-section" : ".side-card");
          assert.equal((await rendered.innerText()).trim(), adapted.summary.trim(), "The UI must display the actual generated text");
        }
        assert.doesNotMatch(await viewer.locator("main").innerText(), /Sample medication \(test fixture\)|Example clinic|Local test fixture/);
        await viewer.screenshot({ path: join(artifacts, `live-${kind}-${role.toLowerCase()}.png`), fullPage: true });
        viewers.push(viewer);
      }
      writeFileSync(join(artifacts, `live-${kind}-summary.json`), JSON.stringify(summary, null, 2));
      const result = { inputKind: kind, patientLink: accepted.link, jobStage: job.stage, latencyMs: Date.now() - started,
        agentRuntimeArn: job.meta.agentRuntimeArn, sourceChars: job.meta.sourceChars, responseKeys: Object.keys(summary["llm-summary"] as object),
        generatedCharacters: adapted.summary.length, structuredPlan: !!adapted.record.byLang.en, browserRoles: ["patient", "caregiver"], passed: true };
      cases.push(result); console.log(JSON.stringify({ check: "live-browser", ...result }));
      if (owned) assert.ok(owned.outbox.slice(-2).every(mail => mail.text.includes(accepted.link)));
      return { accepted, viewers };
    };
    await doctor.getByLabel("Visit writeup", { exact: true }).fill(notes);
    await submit("text");
    await doctor.getByLabel("Visit writeup", { exact: true }).fill("");
    const pdf = readFileSync(join(import.meta.dirname, "../fixtures/synthetic-discharge.pdf"));
    await doctor.locator("input[type=file]").setInputFiles({ name: "synthetic-furosemide.pdf", mimeType: "application/pdf", buffer: pdf });
    await doctor.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement).value.includes("Furosemide"));
    await submit("pdf");
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    if (owned) assert.equal(owned.outbox.length, 4);
    const report = { verifiedAt: new Date().toISOString(), mode: "local-agentcore", runtimeArn: health.providers.agentRuntimeArn,
      liveInvocationAndBrowserVerified: true, clinicalCorrectnessVerified: false, storage: "local", dictation: "disabled", email: "captured locally", cases };
    writeFileSync(join(artifacts, "live-workflow-report.json"), JSON.stringify(report, null, 2));
  } catch (error) {
    writeFileSync(join(artifacts, "live-workflow-report.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), passed: false, cases, error: String(error) }, null, 2));
    throw error;
  } finally { await browser?.close(); await owned?.close(); agent?.close(); }
});
