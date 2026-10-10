# DischargeAI backend: task list (Kiro tasks), branch `alt-backend`

Checked items are done and pushed. R items were the research stage, B items the first build (branch `backend`, which this branch grew from), A items the additive alignment with the team diagram and the real team infrastructure (this branch). Each item names the files it touches and how it was verified.

## R. Research (done 2026-10-10)

- [x] R1 Read the challenge brief, Advik's API note, the advisors' note, the five example summaries and the sponsor facts.
- [x] R2 Verify the stack installs in this container (Node 22.22, npm 10.9): Express 5.3, zod 4.6, pino 10.4, better-sqlite3 13.0, multer 2.4, nodemailer 10.1, pdf-parse 2.4.5, pdfjs-dist 6.4, p-queue 9.3, swagger-ui-express 5.0, yaml 2.9, AWS SDK v3 3.1149 (bedrock-runtime, dynamodb, lib-dynamodb, sesv2, sqs, transcribe, s3, secrets-manager), mysql2 3.24.5, text-readability 1.1, vitest 5.0, supertest 7.3, tsx 4.23, typescript 7.0, node-sql-parser 5.4 (dev).
- [x] R3 Smoke-test Express 5 + multer + zod + p-queue + better-sqlite3 + AES-256-GCM + vitest + supertest + tsx + tsc together in ESM mode.
- [x] R4 Parse the hackathon discharge PDF with pdf-parse v2 and with the pdfjs-dist legacy fallback.
- [x] R5 Run live Bedrock Converse with tool-based JSON on `us.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-haiku-4-5-20251001-v1:0`; record shapes in research.md.
- [x] R6 Run DynamoDB Local (jar, Java 21) and exercise CreateTable + UpdateTimeToLive + item commands through lib-dynamodb.
- [x] R7 Verify nodemailer 10 transports construct (console, stream, SES v2, SMTP); swagger-ui-express serves on Express 5.
- [x] R8 Record exact request/response shapes for Converse, lib-dynamodb, SES v2, SQS, Transcribe Medical, S3, nodemailer, pdf-parse, mysql2, Secrets Manager in docs/research.md.
- [x] R9 Write docs/spec.md, docs/design.md, docs/tasks.md, docs/research.md.

## B. First build (branch `backend`, carried over)

- [x] B1 Project skeleton: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `vitest.config.ts`, `src/config.ts`, `src/logger.ts` (pino with PHI redaction), `src/clock.ts`, middleware, `src/app.ts`, `src/index.ts`. `GET /health` serves.
- [x] B2 SQL layer and migrations: `src/db/index.ts`, `src/db/migrate.ts`, `0001_init.sql`, repos for patients, links, jobs, audit, checklist, `fixtures/patients.seed.json`, `scripts/seed.ts`. `test/patients.test.ts`.
- [x] B3 Crypto and document store: `src/crypto/linkId.ts`, `src/crypto/envelope.ts`, `src/docstore/*`, DynamoDB Local tooling. `test/crypto.test.ts`.
- [x] B4 Fixtures: the five example summaries (txt), Example 1 as PDF, curated simplified fixtures, Spanish translation of Example 1, a dictation transcript.
- [x] B5 Agents: `SimplifierAgent`, `TranslatorAgent`, `TranscriberAgent` interfaces; offline, Bedrock (Converse tool JSON) and Anthropic providers; Transcribe Medical client.
- [x] B6 Verification: `src/verify/fidelity.ts` (name + numeric dose presence, unit normalization), `backtranslate.ts`, `readability.ts`. `test/fidelity.test.ts` catches an injected wrong dose.
- [x] B7 Extraction and ingest pipeline: `src/extract/pdf.ts`, `src/pipeline/queue.ts`, `src/pipeline/ingestJob.ts`, `src/routes/ingest.ts`, `src/routes/jobs.ts`. `test/ingest-text.test.ts`, `test/ingest-pdf.test.ts`.
- [x] B8 Patient endpoints: summary, translate (cache first), languages, checklist. `test/translate-cache.test.ts`, `test/checklist.test.ts`.
- [x] B9 Email: console | smtp | ses transports, SQS queue + worker with Lambda handler. Caregiver email only with approval.
- [x] B10 Clock, purge, admin, audit: `src/pipeline/purge.ts`, `src/routes/admin.ts`, `src/routes/audit.ts`. `test/expiry-purge.test.ts`, `test/auth.test.ts`.
- [x] B11 OpenAPI at `/docs` and `/openapi.json`.
- [x] B12 Live Bedrock run: `scripts/live-ingest.ts`, sample under `fixtures/live-samples/`.
- [x] B13 Demo script and README.

## A. Additive alignment with the team diagram and the real infrastructure (this branch)

- [x] A1 Contract: `src/agents/aiOutput.ts` (zod schema of the fixed per-language JSON, projection from the richer summary), `contracts/ai-output.schema.json`, `contracts/ai-output.ts`, served at `/contracts`. `test/contract.test.ts`.
- [x] A2 Pipeline module: `src/agents/pipeline.ts` with the four stage interfaces (transcribe, simplify, safetyCheck, translate) and `runPipeline`; the ingest job runs on it. `test/pipeline.test.ts`.
- [x] A3 Audio store: `src/audiostore/` (S3 with SSE and a local twin, sealed with the link key), purge deletes audio, deletion receipts for every key, document and audio object. `test/audio-store.test.ts`.
- [x] A4 Translation at synthesis: `languages[]` on `POST /ingest`, the translating stage, `links.languages`; any other language translated on first request and cached.
- [x] A5 Routes `GET /p/:token` and `POST /synthesize` on the shared loader `src/routes/patientView.ts`; `GET /summary` and `GET /translate` use the same loader. `test/patient-link.test.ts`, `test/synthesize.test.ts`.
- [x] A6 Offline Mandarin and Arabic fixtures for Example 1. `test/translation-fixtures.test.ts`.
- [x] A7 The team table: DynamoDB `discharge-summaries`, hash key `uid`, one item per link with one attribute per document, TTL `expiresAt`; SQL twin `discharge_summaries`; `scripts/setup-dynamo.ts` idempotent. `test/docstore.test.ts` (faked client; the real table exercised by `scripts/live-infra-check.ts`).
- [x] A8 Config bootstrap from Secrets Manager: `src/config/secrets.ts`, env wins, names only logged, `/health` reports the source. `test/secrets.test.ts`.
- [x] A9 MariaDB/MySQL adapter: `src/db/mysql.ts` (mysql2 pool, TLS from the RDS bundle), per-dialect migrations (`migrations/sqlite/`, `migrations/mysql/`), `SQL_DRIVER=auto` with fallback, `scripts/fetch-rds-bundle.sh`, `certs/global-bundle.pem`; Postgres removed. `test/mysql.test.ts` (faked pool, MariaDB DDL parsed, fallback against a closed port).
- [x] A10 Team bucket: `AUDIO_BUCKET=emraudio-rh`, `AUDIO_STORE=auto` probing the bucket with fallback, `scripts/ensure-s3-lifecycle.ts` verifying the existing 30-day rule. `test/audio-select.test.ts`.
- [x] A11 Live checks from the build container (10 Oct 2026): `scripts/live-infra-check.ts` (Secrets Manager, DynamoDB put/get/list/delete, S3 put/head/get/delete, Bedrock ping, MySQL TCP), `fixtures/live-samples/infra-check.2026-10-10.json`; `scripts/live-ingest.ts` with `LLM_PROVIDER=bedrock DOC_STORE=dynamo` through the real table, self-cleaning.
- [x] A12 OpenAPI rewritten for this surface (20 paths, 24 schemas); `scripts/demo.sh` extended; `.env.example` updated.
- [x] A13 README.md for this branch (precedence, lane table, team infrastructure, run in one command, demo narrative, env table, needs-a-key table, what the other branch has), root README pointer, docs updated.
- [x] A14 Final verification: `npm test` 88/88 in 19 files, `npm run typecheck` clean, every public route curled against a running offline server, `npm run demo` completes.

## Open (not done here)

- [ ] First live run against the RDS MariaDB instance from the EC2 host (port 3306 is closed to the build container): `SQL_DRIVER=mysql npm run dev`, then `npm run demo`.
- [ ] SES sender verification and `EMAIL_TRANSPORT=ses` on the host; Transcribe Medical with a real dictation.
- [ ] Frontend wiring to `POST /ingest` and `GET /p/:token` (lane 1).
