import { createAuditSink, type AuditSink } from "./audit/receipts.js";
import { Clock } from "./clock.js";
import { LINK_TTL_DAYS, loadConfig, type Config } from "./config.js";
import { createObjectStores, type ObjectStore } from "./data/objects.js";
import { migrate } from "./db/migrate.js";
import { openDb, type Db } from "./db/index.js";
import { ActiveLinksRepo } from "./db/repos/activeLinks.js";
import { AuditRepo } from "./db/repos/audit.js";
import { JobsRepo } from "./db/repos/jobs.js";
import { PatientsRepo } from "./db/repos/patients.js";
import { createSummaryStore, type SummaryStore } from "./docstore/index.js";
import { createMailer, type Mailer } from "./email/mailer.js";
import { createSqsEmailQueue, type EmailQueue } from "./email/queue.js";
import { createLogger, type Logger } from "./logger.js";
import { runIngestJob, type PendingInput } from "./pipeline/ingestJob.js";
import { runPurge, type PurgeReport } from "./pipeline/purge.js";
import { JobQueue } from "./pipeline/queue.js";
import { createAgent, type AgentProvider } from "./pipeline/agent.js";
import { createSpeechToText, type SpeechToText } from "./pipeline/speechToText.js";
import type { SecretsBootstrapResult } from "./secrets.js";
import { ElevenLabsReadAloud, type ReadAloudProvider } from "./pipeline/readAloud.js";
import { MedicalLiveDictation, type LiveDictationProvider } from "./pipeline/liveDictation.js";

export const NO_SECRETS: SecretsBootstrapResult = { source: "env", applied: [], overriddenByEnv: [], missingKeys: [], reason: "not attempted", ms: 0 };

/** Everything a route or a job needs, wired once at boot. */
export interface AppContext {
  /** Present only in the explicitly launched, isolated local verification server. */
  mode?: "local-test" | "local-agentcore";
  config: Config;
  /** Where the configuration came from (names only), for /health. */
  secrets: SecretsBootstrapResult;
  log: Logger;
  clock: Clock;
  db: Db;
  patients: PatientsRepo;
  activeLinks: ActiveLinksRepo;
  jobs: JobsRepo;
  audit: AuditRepo;
  /** The team DynamoDB table (one item per summary). */
  summaries: SummaryStore;
  /** The PDF bucket (emrpdf-rh). */
  pdf: ObjectStore;
  /** The audio bucket (emraudio-rh). */
  audio: ObjectStore;
  /** Deletion receipts sink (sql by default). */
  receipts: AuditSink;
  /** The DischargeAI agent on Bedrock AgentCore Runtime. */
  agent: AgentProvider;
  speechToText: SpeechToText;
  liveDictation?: LiveDictationProvider;
  readAloud?: ReadAloudProvider;
  mailer: Mailer;
  emailQueue?: EmailQueue;
  queue: JobQueue;
  linkTtlDays: number;
  patientUrl(sumId: string): string;
  enqueueIngest(jobId: string, pending?: PendingInput): void;
  purge(): Promise<PurgeReport>;
  startPurgeTimer(): void;
  close(): Promise<void>;
}

export interface CreateContextOptions {
  env?: Record<string, string | undefined>;
  overrides?: Partial<Config>;
  /** The Secrets Manager bootstrap report from loadRuntimeEnv, for /health. */
  secrets?: SecretsBootstrapResult;
  /** Re-enqueue jobs left unfinished by a previous process (the API server does; one-shot scripts must not). */
  resumeJobs?: boolean;
}

export async function createContext(opts: CreateContextOptions = {}): Promise<AppContext> {
  const config = loadConfig(opts.env ?? process.env, opts.overrides);
  const log = createLogger(config.LOG_LEVEL);
  const clock = new Clock(config.DEMO_NOW);
  if (config.DEMO_NOW) log.warn({ demoNow: config.DEMO_NOW, offsetDays: clock.offsetDays }, "DEMO_NOW is set: the app clock is pinned for a demo");
  const db = await openDb(config);
  log.info({ sql: db.describe }, "sql connected");
  const ran = await migrate(db, () => clock.nowIso(), (changes) => log.warn({ changes }, "pre-contract tables set aside: renamed to *_pre_contract, rows kept"));
  if (ran.length) log.info({ migrations: ran }, "migrations applied");

  // The team's patient table, read-only. Its columns are mapped once here; startup stops with the real
  // column list when the table is missing or has no id column, instead of serving the wrong data.
  const patients = new PatientsRepo(db, config.PATIENTS_TABLE);
  const patientsTable = await patients.init();
  // Column names only, as "field=column" strings (field-named keys would be caught by the PHI redaction).
  log.info({ table: patientsTable.table, mapping: Object.entries(patientsTable.mapped).map(([f, c]) => `${f}=${c}`), unmappedContractKeys: patientsTable.unmapped }, "patients table");
  const activeLinks = new ActiveLinksRepo(db);
  const jobs = new JobsRepo(db);
  const audit = new AuditRepo(db);
  const secrets = opts.secrets ?? NO_SECRETS;
  const summaries = createSummaryStore(config);
  log.info({ docStore: summaries.describe }, "document store");
  const stores = createObjectStores(config);
  log.info({ pdf: stores.pdf.describe(), audio: stores.audio.describe() }, "object stores");
  const receipts = await createAuditSink(config, { audit });

  const agent = createAgent(config, log);
  const speechToText = await createSpeechToText(config, log);
  const mailer = await createMailer(config, log);
  const emailQueue =
    config.EMAIL_QUEUE === "sqs"
      ? createSqsEmailQueue({ queueUrl: requireEnv(config.SQS_QUEUE_URL, "SQS_QUEUE_URL"), region: config.AWS_REGION })
      : undefined;
  const queue = new JobQueue();
  let purgeTimer: NodeJS.Timeout | undefined;

  const ctx: AppContext = {
    config,
    secrets,
    log,
    clock,
    db,
    patients,
    activeLinks,
    jobs,
    audit,
    summaries,
    pdf: stores.pdf,
    audio: stores.audio,
    receipts,
    agent,
    speechToText,
    liveDictation: new MedicalLiveDictation(config.TRANSCRIBE_STREAMING_REGION),
    readAloud: config.ELEVENLABS_API_KEY ? new ElevenLabsReadAloud(config) : undefined,
    mailer,
    emailQueue,
    queue,
    linkTtlDays: LINK_TTL_DAYS,
    patientUrl: (sumId) => `${config.PATIENT_APP_URL.replace(/\/$/, "")}/s/${sumId}`,
    enqueueIngest: (jobId, pending) => queue.add(jobId, () => runIngestJob(ctx, jobId, pending)),
    purge: () => runPurge(ctx),
    startPurgeTimer: () => {
      if (purgeTimer || config.PURGE_INTERVAL_MS <= 0) return;
      purgeTimer = setInterval(() => {
        runPurge(ctx).catch((err) => log.error({ err: { message: (err as Error).message } }, "purge failed"));
      }, config.PURGE_INTERVAL_MS);
      purgeTimer.unref();
    },
    close: async () => {
      if (purgeTimer) clearInterval(purgeTimer);
      await queue.onIdle();
      await db.close();
    },
  };

  // Resume jobs that were in flight when the process last stopped.
  if (opts.resumeJobs !== false) {
    const unfinished = await jobs.listUnfinished();
    for (const job of unfinished) {
      log.info({ jobId: job.id, stage: job.stage }, "resuming unfinished job");
      ctx.enqueueIngest(job.id);
    }
  }

  return ctx;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
