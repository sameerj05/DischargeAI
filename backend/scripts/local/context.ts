import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { SqlAuditSink } from "../../src/audit/receipts.js";
import { Clock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { NO_SECRETS, type AppContext } from "../../src/context.js";
import type { ObjectStore, StoredObject } from "../../src/data/objects.js";
import { splitStatements, type Db, type SqlParam } from "../../src/db/index.js";
import { ActiveLinksRepo } from "../../src/db/repos/activeLinks.js";
import { AuditRepo } from "../../src/db/repos/audit.js";
import { JobsRepo } from "../../src/db/repos/jobs.js";
import { PatientsRepo } from "../../src/db/repos/patients.js";
import type { SummaryItem, SummaryPatch, SummaryStore } from "../../src/docstore/types.js";
import type { LinkEmail } from "../../src/email/templates.js";
import { createLogger } from "../../src/logger.js";
import { runIngestJob } from "../../src/pipeline/ingestJob.js";
import { runPurge } from "../../src/pipeline/purge.js";
import { JobQueue } from "../../src/pipeline/queue.js";
import type { AgentProvider } from "../../src/pipeline/agent.js";
import type { Config } from "../../src/config.js";
import type { SpeechToText } from "../../src/pipeline/types.js";
import type { ReadAloudProvider } from "../../src/pipeline/readAloud.js";
import type { LiveDictationProvider } from "../../src/pipeline/liveDictation.js";

export interface LocalProviders { agent?: AgentProvider; speech?: SpeechToText; liveDictation?: LiveDictationProvider; readAloud?: ReadAloudProvider; config?: Partial<Config>; dataDir?: string }

export const LOCAL_PROVIDER_KEY = "local-test-key";
export const LOCAL_AUDIO_TRANSCRIPT = "Synthetic audio transcript for local workflow testing. This is a fixed fixture, not recognized speech.";
export const LOCAL_FAILURE_MARKER = "[LOCAL_TEST_FAIL]";

/** Real SQL for the production repositories, scoped to one local process. Not an RDS adapter. */
class LocalSql implements Db {
  readonly describe: string;
  private readonly sqlite: DatabaseSync;
  constructor(dataDir?: string) {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const file = dataDir ? join(dataDir, "dischargeai.sqlite") : ":memory:";
    this.sqlite = new DatabaseSync(file); this.describe = `sqlite:${file} (local only)`;
  }

  async run(sql: string, params: SqlParam[] = []) {
    return { changes: Number(this.sqlite.prepare(sql).run(...params).changes) };
  }
  async get<T>(sql: string, params: SqlParam[] = []) {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }
  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    // PatientsRepo discovers the team's MySQL columns. Supply the equivalent SQLite metadata.
    if (sql.includes("information_schema.COLUMNS")) sql = "SELECT name FROM pragma_table_info(?) ORDER BY cid";
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  async exec(sql: string) { this.sqlite.exec(sql); }
  async close() { this.sqlite.close(); }

  async initialize() {
    await this.exec("PRAGMA foreign_keys = ON");
    const version = await this.get<{ user_version: number }>("PRAGMA user_version");
    if (!version?.user_version) {
    const migrations = join(import.meta.dirname, "../../src/db/migrations");
    // Reuse portable table definitions. MySQL foreign-key/width ALTERs do not apply to SQLite.
    await this.exec(readFileSync(join(migrations, "0001_init.sql"), "utf8"));
    for (const statement of splitStatements(readFileSync(join(migrations, "0002_patientinfo.mysql.sql"), "utf8"))) {
      if (/^CREATE TABLE/i.test(statement)) await this.exec(statement);
    }
    await this.exec(readFileSync(join(migrations, "0003_drop_ingest_language.sql"), "utf8"));
    await this.exec("PRAGMA user_version = 1");
    }
    await this.exec("CREATE TABLE IF NOT EXISTS local_summaries (uid TEXT PRIMARY KEY, item TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_objects (kind TEXT NOT NULL, key TEXT NOT NULL, contentType TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY(kind, key))");
    for (const [id, first, last] of [["7", "Alex", "Example"], ["8", "Jordan", "Sample"]]) {
      await this.run("INSERT OR IGNORE INTO patientinfo (ID, DOB, FirstName, LastName, email, caregiverEmail, preferredLanguage) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, "2000-01-01", first, last, `patient-${id}@example.test`, `caregiver-${id}@example.test`, "en"]);
    }
  }
}

class SqliteSummaries implements SummaryStore {
  readonly name = "sqlite" as const;
  readonly describe = "local SQLite summaries";
  constructor(private readonly db: Db) {}
  async put(item: SummaryItem) { await this.db.run("INSERT OR REPLACE INTO local_summaries VALUES (?, ?)", [item.uid, JSON.stringify(item)]); }
  async get(uid: string) { const row = await this.db.get<{ item: string }>("SELECT item FROM local_summaries WHERE uid = ?", [uid]); return row ? JSON.parse(row.item) as SummaryItem : null; }
  async update(uid: string, patch: SummaryPatch) {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!fields.length) return;
    const expressions = fields.map(() => "?, json(?)").join(", ");
    const params = fields.flatMap(([key, value]) => [`$."${key}"`, JSON.stringify(value)!]);
    const result = await this.db.run(`UPDATE local_summaries SET item = json_set(item, ${expressions}) WHERE uid = ?`, [...params, uid]);
    if (!result.changes) throw new Error("local summary missing");
  }
  async delete(uid: string) { return (await this.db.run("DELETE FROM local_summaries WHERE uid = ?", [uid])).changes > 0; }
  async listExpired(now: number, limit = 500) { return this.db.all<{ uid: string; expiresAt: number }>("SELECT uid, json_extract(item, '$.expiresAt') AS expiresAt FROM local_summaries WHERE json_extract(item, '$.expiresAt') <= ? LIMIT ?", [now, limit]); }
}

class SqliteObjects implements ObjectStore {
  readonly name = "sqlite" as const;
  constructor(private readonly db: Db, private readonly kind: string) {}
  describe() { return `local SQLite ${this.kind}`; }
  async put(item: StoredObject) { await this.db.run("INSERT OR REPLACE INTO local_objects VALUES (?, ?, ?, ?)", [this.kind, item.key, item.contentType ?? "application/octet-stream", item.body]); }
  async get(key: string) { const row = await this.db.get<{ contentType: string; body: Uint8Array }>("SELECT contentType, body FROM local_objects WHERE kind = ? AND key = ?", [this.kind, key]); return row ? { key, contentType: row.contentType, body: Buffer.from(row.body) } : null; }
  async delete(key: string) { return (await this.db.run("DELETE FROM local_objects WHERE kind = ? AND key = ?", [this.kind, key])).changes > 0; }
}

class LocalSummaries implements SummaryStore {
  readonly name = "memory";
  readonly describe = "in-memory summaries (local test only)";
  private readonly items = new Map<string, SummaryItem>();
  async put(item: SummaryItem) { this.items.set(item.uid, structuredClone(item)); }
  async get(uid: string) { return structuredClone(this.items.get(uid) ?? null); }
  async update(uid: string, patch: SummaryPatch) {
    const item = this.items.get(uid);
    if (!item) throw new Error("local summary missing");
    Object.assign(item, structuredClone(patch));
  }
  async delete(uid: string) { return this.items.delete(uid); }
  async listExpired(now: number, limit = 500) {
    return [...this.items.values()].filter(i => i.expiresAt <= now).slice(0, limit).map(i => ({ uid: i.uid, expiresAt: i.expiresAt }));
  }
}

class LocalObjects implements ObjectStore {
  readonly name = "memory";
  private readonly items = new Map<string, StoredObject>();
  constructor(private readonly kind: string) {}
  describe() { return `in-memory ${this.kind} (local test only)`; }
  async put(item: StoredObject) { this.items.set(item.key, { ...item, body: Buffer.from(item.body) }); }
  async get(key: string) {
    const item = this.items.get(key);
    return item ? { ...item, body: Buffer.from(item.body) } : null;
  }
  async delete(key: string) { return this.items.delete(key); }
}

/** A labeled fixture exercises structured-plan rendering and carries the actual submitted text. */
function fixtureResponse(notes: string) {
  return {
    status: "needs_clinician_check", flags: ["Local test fixture. No AI generation or clinical review was performed."],
    summary: `Local test summary\n\nSubmitted notes:\n${notes}`,
    plan: {
      why_in_hospital: [{ text: "Synthetic case for testing the application." }],
      schedule: { once_daily: [{ medicine: "Sample medication (test fixture)", purpose: "Fixed example for interface testing", note: "Not extracted from your notes" }] },
      new_medicines: [], changed_medicines: [], stopped_medicines: [], tests: [],
      appointments: [{ who: "Example clinic", when: "Example follow-up", where: "Test location", why: "Interface test", date_known: false }],
      care_instructions: [{ text: `Submitted notes: ${notes}` }],
      questions_for_care_team: [], call_doctor_if: [], get_help_now_if: [],
    },
  };
}

export async function createLocalContext(opts: LocalProviders & { port?: number; agentDelayMs?: number } = {}) {
  // Deliberately do not load .env, bootstrap secrets, resolve credentials, or build AWS clients.
  const config = loadConfig({}, {
    HOST: "127.0.0.1", PORT: opts.port ?? 4000, LOG_LEVEL: "silent",
    SECRETS_BOOTSTRAP: "off", PURGE_INTERVAL_MS: 0, PROVIDER_API_KEY: LOCAL_PROVIDER_KEY,
    AGENT_RUNTIME_ARN: opts.agent?.runtimeArn ?? "local-fixture", PDF_BUCKET: "local-test", AUDIO_BUCKET: "local-test", ...opts.config,
  });
  const db = new LocalSql(opts.dataDir);
  await db.initialize();
  const patients = new PatientsRepo(db, config.PATIENTS_TABLE);
  await patients.init();
  const audit = new AuditRepo(db);
  const queue = new JobQueue();
  const outbox: LinkEmail[] = [];
  const ctx: AppContext = {
    mode: opts.agent ? "local-agentcore" : "local-test", config,
    secrets: { ...NO_SECRETS, reason: opts.agent ? "local storage; live AgentCore only; secret bootstrap disabled" : "isolated local test; AWS disabled" },
    db, patients, audit, log: createLogger("silent"), clock: new Clock(), linkTtlDays: 30,
    activeLinks: new ActiveLinksRepo(db), jobs: new JobsRepo(db), receipts: new SqlAuditSink(audit),
    summaries: opts.dataDir ? new SqliteSummaries(db) : new LocalSummaries(), pdf: opts.dataDir ? new SqliteObjects(db, "PDF files") : new LocalObjects("PDF files"), audio: opts.dataDir ? new SqliteObjects(db, "audio files") : new LocalObjects("audio files"), queue,
    agent: opts.agent ?? {
      name: "local-fixture", runtimeArn: "local-fixture",
      async invoke(notes, sessionId) {
        const started = Date.now();
        await delay(opts.agentDelayMs ?? 600);
        if (notes.includes(LOCAL_FAILURE_MARKER)) throw new Error("Intentional local test agent failure");
        return { response: fixtureResponse(notes), sessionId, latencyMs: Date.now() - started };
      },
    },
    readAloud: opts.readAloud,
    liveDictation: opts.liveDictation ?? (opts.agent ? undefined : {
      name: "local-fixture",
      async *transcribe(audio, _sampleRate, signal) {
        let received = false;
        for await (const chunk of audio) {
          if (signal.aborted) return;
          if (chunk.length && !received) {
            received = true;
            yield { id: "fixture", text: "Synthetic audio transcript", partial: true };
          }
        }
        if (received && !signal.aborted) yield { id: "fixture", text: LOCAL_AUDIO_TRANSCRIPT, partial: false };
      },
    }),
    speechToText: opts.speech ?? (opts.agent ? { name: "unavailable", async transcribe() { throw new Error("Live dictation is unavailable with local storage. Paste notes or upload a readable PDF."); } }
      : { name: "local-fixture", async transcribe() { return { transcript: LOCAL_AUDIO_TRANSCRIPT, provider: "local-fixture", latencyMs: 0 }; } }),
    mailer: { transportName: "local-outbox", async send(mail) {
      outbox.push(structuredClone(mail));
      return { messageId: randomUUID(), transport: "local-outbox" };
    } },
    patientUrl: id => `${config.PATIENT_APP_URL}/s/${id}`,
    enqueueIngest: (jobId, pending) => queue.add(jobId, () => runIngestJob(ctx, jobId, pending)),
    purge: () => runPurge(ctx), startPurgeTimer: () => {},
    close: async () => { await queue.onIdle(); await db.close(); },
  };
  return { ctx, outbox };
}
