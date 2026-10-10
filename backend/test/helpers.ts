import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { createContext, type AppContext, type CreateContextOptions } from "../src/context.js";
import type { Mailer, SentMail } from "../src/email/mailer.js";
import type { LinkEmail } from "../src/email/templates.js";

export const PROVIDER_KEY = "test-provider-key";
export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export function exampleText(name = "example-1-chf"): string {
  return readFileSync(join(FIXTURES, "discharge-summaries", `${name}.txt`), "utf8");
}

export function examplePdf(name = "example-1-chf"): Buffer {
  return readFileSync(join(FIXTURES, "discharge-summaries", `${name}.pdf`));
}

/** A mailer that records instead of printing, so tests can assert on what was sent. */
export function recordingMailer(): Mailer & { sent: LinkEmail[] } {
  const sent: LinkEmail[] = [];
  return {
    transportName: "console",
    sent,
    async send(mail: LinkEmail): Promise<SentMail> {
      sent.push(mail);
      return { messageId: `test-${sent.length}`, transport: "console", preview: { from: "test", to: mail.to, subject: mail.subject, text: mail.text } };
    },
  };
}

export interface TestApp {
  ctx: AppContext;
  app: ReturnType<typeof buildApp>;
  mailer: ReturnType<typeof recordingMailer>;
  /** Per-test local audio store directory (under backend/data, gitignored), removed on close. */
  audioDir: string;
  provider: (req: request.Test) => request.Test;
  close: () => Promise<void>;
}

export async function createTestApp(opts: CreateContextOptions = {}): Promise<TestApp> {
  const mailer = recordingMailer();
  mkdirSync(join(import.meta.dirname, "..", "data"), { recursive: true });
  const audioDir = mkdtempSync(join(import.meta.dirname, "..", "data", "test-audio-"));
  const ctx = await createContext({
    env: { ...process.env, DATABASE_FILE: ":memory:", DATABASE_URL: "", LOG_LEVEL: "silent", PURGE_INTERVAL_MS: "0", DEMO_MODE: "true", PROVIDER_API_KEY: PROVIDER_KEY, LLM_PROVIDER: "offline", TRANSCRIBE_PROVIDER: "offline", DOC_STORE: "local", EMAIL_QUEUE: "none", AUDIO_STORE: "local", AUDIO_DIR: audioDir },
    mailer,
    ...opts,
  });
  const app = buildApp(ctx);
  return {
    ctx,
    app,
    mailer,
    audioDir,
    provider: (req) => req.set("x-provider-key", PROVIDER_KEY),
    close: async () => {
      await ctx.close();
      rmSync(audioDir, { recursive: true, force: true });
    },
  };
}

/** Ingests text for the first seeded patient and waits for the pipeline to finish. */
export async function ingestText(t: TestApp, text: string, extra: Record<string, string | string[]> = {}, patientIndex = 0) {
  const { body: list } = await t.provider(request(t.app).get("/patients"));
  const patientId: string = list.patients[patientIndex].id;
  let req = t.provider(request(t.app).post("/ingest")).field("patientId", patientId).field("text", text);
  for (const [k, v] of Object.entries(extra)) {
    for (const one of Array.isArray(v) ? v : [v]) req = req.field(k, one);
  }
  const res = await req;
  if (res.status !== 202) throw new Error(`ingest failed: ${res.status} ${JSON.stringify(res.body)}`);
  await t.ctx.queue.onIdle();
  return { patientId, ...(res.body as { jobId: string; linkId: string; link: string; expiresAt: string; synthesisLanguages: string[] }) };
}
