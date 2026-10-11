import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pdfToText } from "../src/extract/pdfToText.js";
import { normalizeText } from "../src/extract/text.js";
import { startLocalServer } from "./local-server.js";
import { LOCAL_PROVIDER_KEY } from "./local/context.js";
import { z } from "zod";

const path = process.argv[2];
if (!path) throw new Error('Usage: npm run test:practice -- "path/to/practice.pdf"');
const bytes = readFileSync(resolve(path));
const extracted = await pdfToText(bytes);
// Read document contents as sample data. No commands or instructions in the PDF are executed.
const headings = [...extracted.text.matchAll(/^Example\s+(\d+)\s*[—–-]/gm)];
const cases = headings.length ? headings.map((heading, i) => ({ number: Number(heading[1]),
  notes: extracted.text.slice(heading.index, headings[i + 1]?.index ?? extracted.text.length).trim() }))
  : [{ number: 1, notes: extracted.text }];
const local = await startLocalServer(0);
const requests = [];
try {
  const ingest = async (type: "text" | "pdf", data: string, patientID: string) => {
    const response = await fetch(local.origin + "/api/ingest", { method: "POST",
      headers: { "Content-Type": "application/json", "x-provider-key": LOCAL_PROVIDER_KEY }, body: JSON.stringify({ type, data, patientID }) });
    assert.equal(response.status, 202, `Practice ${type} ingest failed`);
    const accepted = z.object({ jobId: z.string(), sumId: z.string(), link: z.string() }).parse(await response.json());
    await local.ctx.queue.onIdle();
    const jobResponse = await fetch(`${local.origin}/api/jobs/${accepted.jobId}`, { headers: { "x-provider-key": LOCAL_PROVIDER_KEY } });
    assert.equal(jobResponse.status, 200); assert.equal(z.object({ stage: z.string() }).parse(await jobResponse.json()).stage, "done");
    const planResponse = await fetch(`${local.origin}/api/p/${accepted.sumId}`);
    assert.equal(planResponse.status, 200);
    const plan = z.object({ patientID: z.string(), "llm-summary": z.object({ status: z.string(), summary: z.string() }) }).parse(await planResponse.json());
    assert.equal(plan.patientID, patientID); assert.equal(plan["llm-summary"].status, "needs_clinician_check");
    const item = (await local.ctx.summaries.get(accepted.sumId))!;
    assert.equal(item["raw-text"], normalizeText(type === "pdf" ? extracted.text : data));
    assert.ok(plan["llm-summary"].summary.includes(item["raw-text"]));
    assert.ok(local.outbox.slice(-2).every(mail => mail.text.includes(accepted.link)));
    return { accepted, item };
  };
  // Whole-document upload checks parsing/storage locally; cases below remain separate notes.
  const full = await ingest("pdf", bytes.toString("base64"), "7");
  assert.deepEqual((await local.ctx.pdf.get(full.item.pdfKey!))?.body, bytes);
  requests.push({ kind: "pdf", pages: extracted.pages, sourceChars: extracted.text.length, passed: true });
  for (const example of cases) {
    await ingest("text", example.notes, "7");
    requests.push({ kind: "text", example: example.number, sourceChars: example.notes.length, passed: true });
  }
  assert.equal(local.outbox.length, 2 * requests.length);
  const report = { verifiedAt: new Date().toISOString(), mode: "local-test", documentPages: extracted.pages, examples: cases.length,
    requests, capturedEmails: local.outbox.length, realAiQualityVerified: false, realAwsVerified: false };
  const artifacts = join(import.meta.dirname, "../../.tools"); mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "practice-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await local.close(); }
