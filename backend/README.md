# DischargeAI backend (branch `alt-backend`)

Discharge instructions go in as pasted EMR text, a PDF or dictated audio. A plain-language version comes out at an unguessable link, in the patient's language, with a checklist they can tick off, and every byte of it self-destructs 30 days after it was created. This directory is lane 2 of the team architecture: the SQL patient database, every API endpoint, the DynamoDB read and write logic, the purge job and the audit trail. The simplification and translation agents sit behind interfaces with a working default (Amazon Bedrock Converse) and an offline twin, so the whole product demos end to end on a laptop with no keys.

## Precedence

Advik's words: "the granola doc takes precedent over the diagram bc diagram could be missing some stuff." So:

1. The Granola API note is the source of truth, and all of it ships here: the SQL patient table (first name, last name, date of birth, zip, email, phone, active link), `GET /patients`, `POST /ingest` (text or PDF, `202 ingestion started`, async PDF to text, LLM simplification, raw and LLM output stored in DynamoDB, the patient emailed the link, optional SQS), `GET /summary`, `GET /translate` with the DynamoDB cache checked first and the translation agent on a miss.
2. The team diagram fills in what the note is silent on: `POST /synthesize`, `GET /p/:token`, the fixed per-language JSON `{ steps, medications, followUps, warnings }`, S3 audio with a 30-day lifecycle, deletion receipts in the audit log, light provider auth, Transcribe Medical, Bedrock Claude at grade 5, safety checks. Where the two disagree the note wins: translation is on demand with a cache, and the languages the provider picks at ingest are also produced during synthesis because that does not contradict the note.
3. The real AWS resources override names in both documents: the table is `discharge-summaries` (not the diagram's `discharge_records`), its hash key is `uid`, the bucket is `emraudio-rh`, and the database is the RDS MariaDB instance `patients`.

## Run it

One command after `npm install` (Node 22):

```sh
cd backend && npm install && npm run dev
```

That boots on http://localhost:4000 with no keys: SQLite, the SQL twin of the document table, offline simplifier and translator, email printed to the console, demo mode on, Swagger UI at `/docs`. Six synthetic patients are seeded on first boot.

```sh
npm run demo        # the judge's narrative against the running server (needs curl and node)
npm test            # vitest, offline providers: 88 tests in 19 files pass (10 Oct 2026)
npm run typecheck   # tsc --noEmit, clean
```

With AWS credentials in the shell (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, or a profile or instance role) the same `npm run dev` fetches the team secret, switches the document store to the real DynamoDB table, the audio store to the real bucket, and SQL to the RDS MariaDB instance when port 3306 is reachable (it falls back to SQLite and says so in `GET /health` when it is not). Add `LLM_PROVIDER=bedrock` for the live model.

## Architecture

```
 Provider app (lane 1)                               Patient phone (lane 1)
        |  x-provider-key                                   |  link id only
        v                                                   v
 +--------------------------------------------------------------------------------+
 |  Express 5 + zod  (src/app.ts)                                                  |
 |  /patients  /ingest  /synthesize  /jobs/:id  /audit  /audit/receipts  /admin/*   |
 |  /p/:token  /summary  /translate  /languages  /checklist  /health  /docs         |
 +----------+-----------------------+----------------------+-----------------------+
            |                       |                      |
 +----------v---------+   +---------v----------+   +-------v---------------------+
 | SQL  (src/db)      |   | Lane-3 pipeline    |   | Document store (src/docstore)|
 |  sqlite (default)  |   | (src/agents/       |   |  DynamoDB discharge-summaries|
 |  mysql: RDS        |   |  pipeline.ts)      |   |   hash key uid, TTL expiresAt|
 |  MariaDB patients  |   |  transcribe        |   |  SQL twin discharge_summaries|
 |  patients          |   |  simplify          |   +------------------------------+
 |  links (enc_key)   |   |  safetyCheck       |   | Audio store (src/audiostore) |
 |  jobs              |   |  translate         |   |  S3 emraudio-rh (SSE, 30-day |
 |  audit_log         |   +---------+----------+   |   lifecycle) or local dir    |
 |  checklist_state   |             |              +------------------------------+
 +--------------------+             |
 +--------------------+   +---------v----------+   Config bootstrap (src/config/secrets.ts):
 | Clock + purge job  |   | Agents             |   Secrets Manager hackhealth/secret fills
 |  DEMO_MODE clock   |   |  bedrock | anthropic|  MYSQL_* and DYNAMO_* when credentials
 |  advance, purge    |   |  | offline          |  resolve; env always wins; values never logged
 +--------------------+   +--------------------+
 Email: console (default) | smtp | ses, optional EMAIL_QUEUE=sqs -> scripts/email-worker.ts (Lambda handler too)
```

Every stored payload (raw text, simplified JSON, translations, the audio clip) is sealed with a per-link AES-256-GCM key kept in `links.enc_key`. Day 30 destroys the key first, then deletes the documents and the audio object, and writes one deletion receipt per thing destroyed. Read paths compare `expiresAt` to the app clock before touching any store, so a lagging TTL never exposes data.

## How this maps to the team architecture diagram

| Lane | What the diagram asks for | What this backend provides | Files |
| --- | --- | --- | --- |
| 1 Frontend (Person A) | Calls `POST /ingest` and `GET /p/:token`; renders the AI JSON schema | Both routes, plus `GET /summary` and `GET /translate` for the richer shape, the published contract at `/contracts/ai-output.ts` and `/contracts/ai-output.schema.json`, `GET /languages`, checklist check-offs | `src/routes/ingest.ts`, `src/routes/patientLink.ts`, `src/routes/patientView.ts`, `contracts/` |
| 2 Backend API (Advik) | Endpoints, token link service, light provider auth, pipeline orchestration; writes `expiresAt` on every record | 128-bit base64url link ids, only their SHA-256 stored; `x-provider-key` on provider routes; the ingest job and `POST /synthesize` drive the pipeline; `expiresAt` (epoch seconds) on every DynamoDB item, every audio object and `links.expires_at` | `src/crypto/linkId.ts`, `src/middleware/providerAuth.ts`, `src/pipeline/ingestJob.ts`, `src/routes/synthesize.ts` |
| 3 AI pipeline (Person C) | Speech to text, simplification and translation prompts, safety checks; raw text in, fixed JSON per language out | `runPipeline({ rawText \| audio, languages })` composed of four stage interfaces (transcribe, simplify, safetyCheck, translate) with the Bedrock, Anthropic and offline implementations; `POST /synthesize` runs it on demand | `src/agents/pipeline.ts`, `src/agents/aiOutput.ts`, `src/agents/prompts/`, `src/verify/` |
| 4 Data, TTL, demo (Person D) | DynamoDB with TTL, S3 lifecycle, deletion receipts, demo with TTL proof; TTL attribute is `expiresAt` | Table `discharge-summaries` (hash key `uid`, TTL `expiresAt`) with an idempotent setup script; bucket `emraudio-rh` with its existing 30-day rule verified by `ensure-s3-lifecycle`; `key.destroyed`, `record.deleted`, `audio.deleted` receipts; `scripts/demo.sh` advances the clock to day 30 and prints the receipts | `src/docstore/`, `src/audiostore/`, `src/pipeline/purge.ts`, `scripts/setup-dynamo.ts`, `scripts/ensure-s3-lifecycle.ts`, `scripts/demo.sh` |

## Team infrastructure

AWS region `us-west-2`, account `183815333909`. Nothing below is a secret; the one secret value (the MariaDB password) lives only in Secrets Manager and is read at runtime.

| Resource | Value |
| --- | --- |
| Secrets Manager secret | `hackhealth/secret`, ARN `arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q`. Keys: `dynamodb-table`, `dynamodb-table-pk`, `mysql-db`, `mysql-host`, `mysql-port`, `mysql-user`, `mysql-password` (read live from this build container on 10 Oct 2026; names only are ever logged) |
| DynamoDB table | `discharge-summaries`, hash key `uid` (string), no sort key, TTL enabled on `expiresAt` (epoch seconds), PAY_PER_REQUEST |
| S3 audio bucket | `emraudio-rh`, lifecycle rule `autodelete` expiring every object after 30 days (plus abort of incomplete multipart uploads after 30 days), objects written with SSE-S3 under `audio/<linkIdHash>` |
| RDS instance | `patients`, MariaDB, db.t4g.micro, host `patients.cleqcmkoulma.us-west-2.rds.amazonaws.com`, port `3306`, user `admin`, database `dischargeai` (the secret's `mysql-db`), IAM authentication enabled, security group open on 3306 |
| Bedrock | Converse API with inference profiles `us.anthropic.claude-sonnet-4-6` (default) and `us.anthropic.claude-haiku-4-5-20251001-v1:0` |

### Config bootstrap

At startup `src/config/secrets.ts` calls `GetSecretValue` on `AWS_SECRET_ARN` (default: the ARN above) when AWS credentials resolve, and fills in whichever of `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `DYNAMO_TABLE`, `DYNAMO_PK` are still empty. An explicit env var always wins. With no credentials (a laptop, CI, the test suite) nothing is fetched and the app runs fully local. `GET /health` reports `config.source` (`env`, `secret`, `env+secret`), which keys were applied and which were kept from env, never a value. `SECRETS_BOOTSTRAP=off` disables the fetch.

### Connecting to the database (AWS "connection steps" for the `patients` instance)

Step 1, the certificate bundle, exactly as the RDS console prints it (committed at `backend/certs/global-bundle.pem`, same bytes as `certs/global-bundle.pem` on `feature/infra-setup`; `sh scripts/fetch-rds-bundle.sh` refreshes it):

```sh
curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

Step 2, the client, with the password pulled from Secrets Manager and never pasted:

```sh
mysql -h patients.cleqcmkoulma.us-west-2.rds.amazonaws.com -P 3306 -u admin \
  -p"$(aws secretsmanager get-secret-value --secret-id 'arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q' --query SecretString --output text | jq -r '.["mysql-password"]')" \
  --ssl-verify-server-cert --ssl-ca=./global-bundle.pem dischargeai
```

The console's own step 2 reads the RDS-managed master secret instead (`--secret-id 'arn:aws:secretsmanager:us-west-2:183815333909:secret:rds!db-665156cf-ffaa-4b3c-9439-886d1d06ed56-SvHjah' ... | jq -r '.password'`); both open the same instance.

The backend does the same over `mysql2`: a promise pool with `ssl: { ca: fs.readFileSync(RDS_CA_BUNDLE), rejectUnauthorized: true }` (the `--ssl-verify-server-cert` of step 2), `CREATE DATABASE IF NOT EXISTS dischargeai` on first connect, then the MySQL migration in `src/db/migrations/mysql/`. `SQL_DRIVER=auto` (default) uses MariaDB when a host is known and falls back to SQLite when the host is unreachable, reporting `sql.fallback` in `/health`; `SQL_DRIVER=mysql` makes that a hard failure; `DATABASE_URL=mysql://user:pass@host:3306/dischargeai` is accepted too.

### IAM permissions the backend needs

| Service | Actions | When |
| --- | --- | --- |
| Secrets Manager | `secretsmanager:GetSecretValue` on the secret ARN | at boot, unless `SECRETS_BOOTSTRAP=off` |
| DynamoDB | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Scan` on `discharge-summaries`; `DescribeTable`, `DescribeTimeToLive`, `UpdateTimeToLive` (and `CreateTable` when it is missing) for `npm run setup-dynamo` | `DOC_STORE=dynamo` or `auto` with the secret loaded |
| Bedrock | `bedrock:InvokeModel` on the two inference profiles (and the underlying foundation models) | `LLM_PROVIDER=bedrock` |
| S3 | `s3:HeadBucket` (ListBucket), `PutObject`, `GetObject`, `DeleteObject` on `arn:aws:s3:::emraudio-rh/audio/*`; `GetLifecycleConfiguration` (and `PutLifecycleConfiguration` only on a bucket without a 30-day rule) for `npm run ensure-s3-lifecycle` | `AUDIO_STORE=s3` or `auto` with the secret loaded |
| SES | `ses:SendEmail` (the From identity must be verified) | `EMAIL_TRANSPORT=ses` |
| SQS | `sqs:SendMessage` (API), `sqs:ReceiveMessage`, `sqs:DeleteMessage` (worker) | `EMAIL_QUEUE=sqs` |
| Transcribe | `transcribe:StartMedicalTranscriptionJob`, `GetMedicalTranscriptionJob`, plus `s3:PutObject`/`GetObject` on the transcribe bucket | `TRANSCRIBE_PROVIDER=aws` |
| RDS | network access to port 3306 (the instance uses the admin password, not IAM tokens) | `SQL_DRIVER=mysql` or `auto` with a host known |

### Verified live, and not

From this build container on 10 Oct 2026 with the Workshop Studio role (`fixtures/live-samples/infra-check.2026-10-10.json` is the report, names only):

| Check | Result |
| --- | --- |
| Secrets Manager `GetSecretValue` | 7 keys read; all seven env vars filled |
| DynamoDB `discharge-summaries` | ACTIVE, key schema `uid HASH`, TTL ENABLED on `expiresAt`; probe item: 2 documents put, read back, one removed, `deleteAll` removed the rest, nothing remaining. A full `POST /ingest` of Example 1 with `DOC_STORE=dynamo` wrote `raw`, `simplified`, `translation#es` on one item and the script deleted them again |
| S3 `emraudio-rh` | HeadBucket ok; lifecycle rule `autodelete` (30 days, whole bucket) found, so nothing was added; probe object put with SSE-S3, head, get (opened with the link key), delete, head returns null |
| Bedrock | `us.anthropic.claude-sonnet-4-6`: ping replied `ok`; the full Example 1 ingest ran through the live simplifier and translator (`fixtures/live-samples/example-1-chf.bedrock.us.anthropic.claude-sonnet-4-6.2026-10-10.json`: fidelity passed, 0 warnings, 3658 input / 2270 output tokens, 16 s) |
| MySQL over 3306 | TCP connect to the RDS host timed out from this container: **not exercised live**. The adapter is written from the mysql2 documentation, its SQL is the SQL the SQLite suite runs, the MySQL migration is parsed as MariaDB DDL in the tests, and the fallback path is tested against a closed port |

Not exercised live from the build container: MySQL/MariaDB (above), SES, SQS, Transcribe Medical, the direct Anthropic API (no key), DynamoDB Local through Docker (no daemon here; the jar path in `scripts/dynamodb-local.sh` was exercised by the earlier build).

## Endpoints

Provider endpoints need `x-provider-key: <PROVIDER_API_KEY>` (`dev-provider-key` by default). Patient endpoints are authenticated by the 22-character link id and are lightly rate limited. Full schemas: `openapi.yaml`, served at `/docs` and `/openapi.json`.

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /health` | open | Clock, config source, which SQL / document / audio store is live and any fallback, providers |
| `GET /contracts`, `/contracts/ai-output.schema.json`, `/contracts/ai-output.ts` | open | The lane-3 contract files |
| `GET /patients?q=`, `POST /patients`, `GET /patients/:id` | provider | List, search, create, read patients (`activeLinkId`, `activeLinkExpiresAt` on each) |
| `POST /ingest` | provider | Multipart: `patientId` + exactly one of `text`, `file` (PDF), `audio`; optional `language`, `languages` (`es,zh,ar`), `caregiverEmail`, `caregiverApproved`. `202 { jobId, linkId, link, patientUrl, expiresAt, statusUrl, synthesisLanguages }` before any model call |
| `POST /synthesize` | provider | `{ text, languages? }` dry run of the pipeline; `{ linkId, languages?, text? }` re-synthesizes a record in place (stale translations deleted with receipts) |
| `GET /jobs/:jobId` | provider | Stage machine: `received, extracting, transcribing, simplifying, checking, translating, stored, emailing, done, needs_review, failed` |
| `GET /audit?link=`, `GET /audit/receipts` | provider | Event trail with `deletionReceipts` pulled out; every receipt in the log |
| `GET /p/:token?language=` | patient | The diagram's read: fixed contract + `meta` (status, expiry, days left, ready languages, safety checks, provenance, checklist state) |
| `GET /summary?link=&language=` | patient | The richer shape: summary, diagnoses, New/Keep/Stop medication cards, checklist, tiered return precautions, follow-ups, questions to ask, `readyLanguages`, verification |
| `GET /translate?link=&language=` | patient | The same in another language, `fromCache` true when stored |
| `GET /languages` | patient | 20 languages, codes, names, native names, and the three synthesis targets |
| `GET /checklist?link=`, `POST /checklist/complete` | patient | Read and persist check-offs `{ link, itemId, completed }` |
| `POST /admin/clock/advance { days }`, `/admin/clock/reset`, `/admin/purge` | provider, `DEMO_MODE` only | Move the app clock, run the purge now |

Status codes on patient reads, in order: `400` malformed token, `404` unknown, `410` expired or purged (checked at read time against the clock), `425` still processing with `{ stage }`.

```sh
K='x-provider-key: dev-provider-key'; B=http://localhost:4000
curl -s -H "$K" $B/patients | jq '.patients[0]'
curl -s -H "$K" -F patientId=pt-0001 -F languages=es,zh,ar -F text=@fixtures/discharge-summaries/example-1-chf.txt $B/ingest
curl -s -H "$K" -F patientId=pt-0001 -F 'file=@fixtures/discharge-summaries/example-1-chf.pdf;type=application/pdf' $B/ingest
curl -s -H "$K" -F patientId=pt-0001 -F 'audio=@dictation.wav;type=audio/wav' $B/ingest
curl -s -H "$K" $B/jobs/<jobId>
curl -s $B/p/<linkId>                        # the contract
curl -s "$B/p/<linkId>?language=zh"          # Mandarin, stored at synthesis if picked, else translated now and cached
curl -s "$B/summary?link=<linkId>"           # the richer shape
curl -s "$B/translate?link=<linkId>&language=Spanish"
curl -s -H 'content-type: application/json' -d '{"link":"<linkId>","itemId":"med-1","completed":true}' $B/checklist/complete
curl -s -H "$K" -H 'content-type: application/json' -d '{"linkId":"<linkId>","languages":["ar"]}' $B/synthesize
curl -s -H "$K" -H 'content-type: application/json' -d '{"days":30}' $B/admin/clock/advance
curl -s -H "$K" -X POST $B/admin/purge | jq '.receipts'
curl -s -H "$K" "$B/audit?link=<linkId>" | jq '.deletionReceipts'
```

## The per-language contract (lane 3 to lane 1)

One object per language, four keys always present, medication names and doses never translated. `contracts/ai-output.ts` is dependency-free so Person A can copy it; `contracts/ai-output.schema.json` is the JSON Schema twin; `npm run test:contract` proves both match the zod validator.

```jsonc
{
  "language": "es", "readingLevel": "grade5",
  "steps":       [{ "id": "med-1", "text": "...", "category": "med", "due": "every morning" }],
  "medications": [{ "name": "Furosemide", "dose": "40 mg", "howOften": "...", "status": "new" | "continue" | "stop", "why": "..." }],
  "followUps":   [{ "who": "...", "when": "...", "why": "..." }],
  "warnings":    [{ "tier": "call911" | "er" | "clinic", "text": "..." }],
  "summary": "...", "diagnoses": [...], "checklist": [...], "questionsToAsk": [...]   // richer, optional
}
```

`GET /p/:token` returns this plus `meta` beside it (never inside): status, `expiresAt`, `daysLeft`, `languages.ready`, `safetyChecks` (fidelity verdict, readability grade, findings, back-translation check), `provenance` (provider, model, input kind, stages, synthesis count), `checklistState`. A failed fidelity check adds one clinic-tier warning to `warnings` in every language, so the patient is told without reading `meta`.

### Person C: how to plug in your prompts

`src/agents/pipeline.ts` is the one module. `createPipeline()` picks four stage implementations; replace any of them:

- `simplify`: `src/agents/prompts/simplify.ts` holds the system prompt, `src/agents/bedrock/simplifier.ts` the Converse call (tool-based JSON, zod-validated, one retry). Or implement `SimplifierAgent` in a new file and register it in `src/agents/simplifier.ts` under a new `LLM_PROVIDER` value.
- `translate`: `src/agents/prompts/translate.ts` and `src/agents/bedrock/translator.ts`; same drop-in rule through `src/agents/translator.ts`. Medication `name`, `dose` and the numbers in `howOften` must come back verbatim; the backend diffs them.
- `safetyCheck`: `deterministicSafetyCheckStage()` runs `src/verify/fidelity.ts` (every medication name and numeric dose in the output must appear in the source) and `src/verify/readability.ts`. Keep it, or wrap it.
- `transcribe`: `src/agents/aws/transcriber.ts` (Transcribe Medical) or `src/agents/offline/transcriber.ts`.

Validate your output against the contract with `npm run test:contract`; run the whole pipeline on a text without storing anything with `POST /synthesize { text, languages }`; re-run a stored record after a prompt change with `POST /synthesize { linkId }`.

## Demo narrative (`npm run demo`)

What the judge sees, with the offline providers, in about three seconds:

1. `GET /health` says which SQL, document store, audio store and config source are live.
2. `GET /patients` picks Harold Jennings.
3. `POST /ingest` with Example 1 (the CHF case) and `languages=es,zh,ar` answers `202` at once with the link and `synthesisLanguages`.
4. The job runs: simplify, safety check (fidelity passed, grade 4.9), translate the three picked languages, store, email. The server prints the patient email: the link and the expiry date, nothing else.
5. `GET /summary` shows the plain-language summary, the four new medicines with doses copied from the source, `daysLeft: 30`, `readyLanguages: [en, ar, es, zh]`.
6. `GET /p/:token` shows the same record as the diagram's contract with `meta`.
7. Spanish, Mandarin and Arabic come back `fromCache: true` with the back-translation check passed; Portuguese is translated on the first request and cached on the second.
8. The patient ticks `med-1` on the checklist.
9. `POST /synthesize` runs the pipeline on the same text as a dry run: `perLanguage` has `en` and `es`, nothing stored.
10. `POST /admin/clock/advance { days: 30 }`: `GET /summary` and `GET /p/:token` answer `410 link_expired` before any purge ran.
11. `POST /admin/purge`: one key destroyed, six documents deleted (raw, simplified, four translations), one receipt each.
12. `GET /audit` lists the events and the seven deletion receipts; `GET /audit/receipts` counts them across all links. No PHI anywhere in it.
13. The clock resets.

With `LLM_PROVIDER=bedrock` the same script runs on the live model (step 4 takes about 45 s); `INPUT=fixtures/discharge-summaries/example-1-chf.pdf npm run demo` runs the PDF path.

## Environment

Every variable has a comment in `.env.example`. Defaults are the offline laptop setup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST`, `LOG_LEVEL` | `4000`, `0.0.0.0`, `info` | Server |
| `PATIENT_APP_URL` | `http://localhost:5173` | Links look like `${PATIENT_APP_URL}/s/<linkId>` |
| `PROVIDER_API_KEY` | `dev-provider-key` | The light provider auth header value |
| `DEMO_MODE` | `true` | Mounts `/admin/*`; set `false` in anything like production |
| `PURGE_INTERVAL_MS` | `60000` | Purge job interval; `0` disables the timer (reads still enforce expiry) |
| `SECRETS_BOOTSTRAP`, `AWS_SECRET_ARN` | `auto`, the team ARN | Config bootstrap from Secrets Manager |
| `SQL_DRIVER` | `auto` | `auto` = MariaDB when `MYSQL_HOST` is known, else SQLite; `sqlite` or `mysql` to force |
| `DATABASE_FILE` | `data/app.db` | SQLite file |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | from the secret; `3306`, `dischargeai` | MariaDB connection; `DATABASE_URL=mysql://...` also accepted |
| `RDS_CA_BUNDLE`, `MYSQL_SSL` | `certs/global-bundle.pem`, `required` | TLS to RDS |
| `DOC_STORE` | `auto` | `auto` = DynamoDB when the secret loaded (or `DYNAMO_ENDPOINT` is set), else the SQL twin; `local` or `dynamo` to force |
| `DYNAMO_TABLE`, `DYNAMO_PK`, `DYNAMO_ENDPOINT` | `discharge-summaries`, `uid`, empty | The team table; endpoint only for DynamoDB Local |
| `KEY_VERSION` | `1` | Tag on every sealed payload |
| `LLM_PROVIDER` | `offline` | `bedrock`, `anthropic`, `offline` |
| `AWS_REGION`, `BEDROCK_MODEL_ID` | `us-west-2`, `us.anthropic.claude-sonnet-4-6` | Bedrock |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | empty, `claude-opus-5-5` | Direct Anthropic API |
| `TRANSCRIBE_PROVIDER`, `TRANSCRIBE_BUCKET`, `TRANSCRIBE_OUTPUT_BUCKET` | `offline`, default to `AUDIO_BUCKET` | Transcribe Medical |
| `AUDIO_STORE`, `AUDIO_BUCKET`, `AUDIO_DIR` | `auto`, `emraudio-rh`, `data/audio` | `auto` = the bucket when the secret loaded and HeadBucket succeeds, else the directory |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SMTP_URL` | `console`, `DischargeAI <noreply@example.test>`, empty | Email |
| `EMAIL_QUEUE`, `SQS_QUEUE_URL` | `none`, empty | Hand email to SQS; `npm run email-worker` consumes it (also a Lambda `handler`) |
| `MAX_UPLOAD_BYTES` | `15728640` | PDF and audio upload limit |

## Needs a key, or not exercised live

| Feature | Needs | Status |
| --- | --- | --- |
| MariaDB on RDS | network access to port 3306 (the EC2 host has it; this build container does not) | Written from the mysql2 docs, tested against SQLite and a faked pool, fallback tested; not exercised live |
| Bedrock simplifier and translator | AWS credentials with `bedrock:InvokeModel` | Verified live, see above |
| DynamoDB document store | AWS credentials | Verified live, see above |
| S3 audio store | AWS credentials | Verified live, see above |
| Transcribe Medical | `TRANSCRIBE_PROVIDER=aws`, bucket permissions | Wired from the API reference; offline transcript fixture used in tests and the demo |
| SES email, SQS queue | `EMAIL_TRANSPORT=ses`, `EMAIL_QUEUE=sqs`, verified sender | Transports construct and are unit-level only; console transport used in tests and the demo |
| Direct Anthropic API | `ANTHROPIC_API_KEY` | Not available in the build container |
| DynamoDB Local via Docker | a Docker daemon | `scripts/dynamodb-local.sh` runs the jar without Docker |

## Data design

SQL (the same tables on SQLite and MariaDB, `src/db/migrations/<dialect>/`): `patients` (first name, last name, date of birth, zip, email, phone, preferred language, active link id and its expiry), `links` (`link_id_hash` = SHA-256 of the id, patient, status, `created_at`, `expires_at` = created + 30 days, `key_version`, `enc_key`, `last_viewed_at`, `language`, `languages`, caregiver email and approval), `jobs` (the persisted stage machine), `audit_log` (event, actor, time, JSON details that never carry PHI), `checklist_state`, and `discharge_summaries`, the SQL twin of the DynamoDB table.

DynamoDB `discharge-summaries`: one item per link. `uid = link#<sha256(linkId)>`, `expiresAt` (the TTL attribute), `createdAt`, `updatedAt`, and one attribute per document named `raw`, `simplified` or `translation#<lang>`, each `{ ciphertext, iv, tag, keyVersion, createdAt }`. A document is written with `UpdateItem SET #doc = :payload, expiresAt = :exp` (so a translation added later never rewrites the raw text), removed with `UpdateItem REMOVE #doc`, and the item is deleted with its last document or by the purge in one `DeleteItem`. One `GetItem` serves every language; TTL expires everything for a link together. `npm run setup-dynamo` creates the table when missing and enables TTL, idempotently.

Audio: `audio/<linkIdHash>` in the bucket (SSE-S3, metadata with the content type and expiry, tag `expiresAt=`), or `<hash>.bin` + `<hash>.json` under `AUDIO_DIR`. Either way the clip is sealed with the link key before it is stored and the bytes are never logged.

Crypto: 16 random bytes, base64url, for the link id; SHA-256 for lookup; a 32-byte data key per link; AES-256-GCM with AAD `uid|doc|keyVersion` for documents and `audio|hash|keyVersion` for clips. `test/expiry-purge.test.ts` proves that ciphertext kept from before the purge cannot be opened with anything the system still holds.

## What stays under human control

- A clinician writes the discharge instructions; the backend only restates and translates them. The product never emits text a patient or a clinician would send as their own (no drafted messages, no "sharpen with AI"), and every patient-facing string is attributed to the system.
- The safety check is deterministic and runs after every model call. A medication name or dose the model produced that is not in the source fails the check, flags the link `needs_review` for the provider, and tells the patient to confirm the list with the care team. It never silently ships.
- The caregiver gets the link only when `caregiverApproved=true` on ingest, the advisors' consent step; otherwise the request is audited as awaiting approval.
- Re-synthesis (`POST /synthesize { linkId }`) is a provider action with the provider key, audited, and counted on the record.
- Day 30 is a constant in code (`LINK_TTL_DAYS`), not a setting.

## What the other branch has

`backend` (the sibling branch, same repo) takes a narrower reading of the note and diagram: it moved the API onto the fixed JSON surface only (`GET /summary`, `GET /translate`, `GET /jobs` serve the contract), replaced the demo clock with a `DEMO_NOW` pin and a one-shot sweep script, dropped `GET /audit` for a `show-audit` script, removed the checklist, `/languages`, the caregiver fields and the richer summary, and keys the DynamoDB table with one item per document (`<linkIdHash>#raw`, `#simplified`, `#translation#<lang>`). It shares this branch's Secrets Manager bootstrap, mysql2 adapter and RDS bundle, and its own `setup-dynamo` script. This branch keeps everything the note asks for plus the extras that make the demo better: checklist check-offs, the `/admin` demo clock and purge-now for the live day-30 proof, caregiver consent, the richer summary served beside the four-key projection, on-demand translation for any of 20 languages with a cache plus the provider-picked languages at synthesis, and `GET /languages`.

## Limitations

- MariaDB is the documented production path but was not reachable from the build container; the first run on the EC2 host is the first live run. `SQL_DRIVER=auto` keeps the demo alive on SQLite if that run fails, and `/health` says so.
- DynamoDB TTL and the S3 lifecycle delete within about a day of expiry. The purge job and the read-time check are the exact 30-day enforcement; the AWS rules are the backstop.
- The offline translator has curated Spanish, Mandarin and Arabic for Example 1, a phrase dictionary for Spanish on anything else, and a marked passthrough (`[pt] ...`) for other languages; real translation needs the Bedrock provider.
- Transcribe Medical is batch and English only; a real dictation takes seconds to minutes and needs the bucket permissions above.
- Rate limiting and the provider key are the only auth; there is no user login. Patient links are 128-bit random and are the credential.

## Sponsor APIs

Amazon Bedrock Converse (`@aws-sdk/client-bedrock-runtime`) is the live simplifier and translator with tool-based JSON output; Secrets Manager, DynamoDB, S3, SES, SQS and Transcribe Medical are used through the AWS SDK v3 as described above. Anthropic's direct API is a second provider behind the same interface. No ElevenLabs or Anakin calls are made by this backend.

## Docs

`docs/spec.md` (requirements as user stories), `docs/design.md` (architecture), `docs/tasks.md` (the build task list, checked off), `docs/research.md` (every source consulted, with URLs actually fetched marked as such), `openapi.yaml`.
