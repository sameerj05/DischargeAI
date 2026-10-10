import { createPipeline, type Pipeline } from "./agents/pipeline.js";
import { createSimplifier, type SimplifierAgent } from "./agents/simplifier.js";
import { createTranscriber, type TranscriberAgent } from "./agents/transcriber.js";
import { createTranslator, type TranslatorAgent } from "./agents/translator.js";
import { Clock } from "./clock.js";
import { LINK_TTL_DAYS, loadConfig, type Config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { openDb, type Db } from "./db/index.js";
import { AuditRepo } from "./db/repos/audit.js";
import { ChecklistRepo } from "./db/repos/checklist.js";
import { JobsRepo } from "./db/repos/jobs.js";
import { LinksRepo } from "./db/repos/links.js";
import { PatientsRepo } from "./db/repos/patients.js";
import { seedPatients } from "./db/seed.js";
import { createDocumentStore, type DocumentStore } from "./docstore/index.js";
import { SecureDocs } from "./docstore/secure.js";
import { createMailer, type Mailer } from "./email/mailer.js";
import { createSqsEmailQueue, type EmailQueue } from "./email/queue.js";
import { createLogger, type Logger } from "./logger.js";
import { runIngestJob, type PendingInput } from "./pipeline/ingestJob.js";
import { runPurge, type PurgeReport } from "./pipeline/purge.js";
import { JobQueue } from "./pipeline/queue.js";

/** Everything a route or a job needs, wired once at boot. Tests build one per test file. */
export interface AppContext {
  config: Config;
  log: Logger;
  clock: Clock;
  db: Db;
  patients: PatientsRepo;
  links: LinksRepo;
  jobs: JobsRepo;
  audit: AuditRepo;
  checklist: ChecklistRepo;
  docStore: DocumentStore;
  secureDocs: SecureDocs;
  simplifier: SimplifierAgent;
  translator: TranslatorAgent;
  transcriber: TranscriberAgent;
  /** Lane 3: transcribe -> simplify -> safety check -> translate, composed in src/agents/pipeline.ts. */
  pipeline: Pipeline;
  mailer: Mailer;
  emailQueue?: EmailQueue;
  queue: JobQueue;
  linkTtlDays: number;
  patientUrl(linkId: string): string;
  enqueueIngest(jobId: string, pending?: PendingInput): void;
  purge(): Promise<PurgeReport>;
  startPurgeTimer(): void;
  close(): Promise<void>;
}

export interface CreateContextOptions {
  env?: Record<string, string | undefined>;
  overrides?: Partial<Config>;
  /** Swap any provider in tests. */
  simplifier?: SimplifierAgent;
  translator?: TranslatorAgent;
  transcriber?: TranscriberAgent;
  pipeline?: Pipeline;
  mailer?: Mailer;
  seed?: boolean;
}

export async function createContext(opts: CreateContextOptions = {}): Promise<AppContext> {
  const config = loadConfig(opts.env ?? process.env, opts.overrides);
  const log = createLogger(config.LOG_LEVEL);
  const clock = new Clock();
  const db = await openDb(config);
  const ran = await migrate(db, () => clock.nowIso());
  if (ran.length) log.info({ migrations: ran }, "migrations applied");

  const patients = new PatientsRepo(db);
  const links = new LinksRepo(db);
  const jobs = new JobsRepo(db);
  const audit = new AuditRepo(db);
  const checklist = new ChecklistRepo(db);
  const docStore = createDocumentStore(config, db);
  const secureDocs = new SecureDocs(docStore);

  if (opts.seed !== false) {
    const added = await seedPatients(patients, audit, () => clock.nowIso());
    if (added) log.info({ added }, "seeded synthetic patients");
  }

  const simplifier = opts.simplifier ?? (await createSimplifier(config, log));
  const translator = opts.translator ?? (await createTranslator(config, log));
  const transcriber = opts.transcriber ?? (await createTranscriber(config, log));
  const pipeline = opts.pipeline ?? createPipeline({ transcriber, simplifier, translator, log });
  const mailer = opts.mailer ?? (await createMailer(config, log));
  const emailQueue =
    config.EMAIL_QUEUE === "sqs"
      ? createSqsEmailQueue({ queueUrl: requireEnv(config.SQS_QUEUE_URL, "SQS_QUEUE_URL"), region: config.AWS_REGION })
      : undefined;
  const queue = new JobQueue();
  let purgeTimer: NodeJS.Timeout | undefined;

  const ctx: AppContext = {
    config,
    log,
    clock,
    db,
    patients,
    links,
    jobs,
    audit,
    checklist,
    docStore,
    secureDocs,
    simplifier,
    translator,
    transcriber,
    pipeline,
    mailer,
    emailQueue,
    queue,
    linkTtlDays: LINK_TTL_DAYS,
    patientUrl: (linkId) => `${config.PATIENT_APP_URL.replace(/\/$/, "")}/s/${linkId}`,
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
  const unfinished = await jobs.listUnfinished();
  for (const job of unfinished) {
    log.info({ jobId: job.id, stage: job.stage }, "resuming unfinished job");
    ctx.enqueueIngest(job.id);
  }

  return ctx;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
