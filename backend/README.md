# DischargeAI backend

Discharge summaries in (pasted text, a PDF, or dictated audio), a patient link out, and every piece of data self-destructs 30 days after it was created. Node 24, TypeScript, Express 5. The team's DischargeAI agent on Amazon Bedrock AgentCore Runtime writes the summary; the backend stores its whole response as it comes back and serves it.

## Combined application

The frontend and AI source now live beside this backend. See [the root README](../README.md) for combined startup, provider-key access, patient links, and validation. All API routes are also available under `/api`; the server serves the built frontend from `frontend/dist` and resolves `/s/<sumId>` to that page. Swagger uses the same-origin `/api` base URL. `npm run docs:serve` serves Swagger on port 4001 without AWS, and `npm test` runs isolated API/SDK integration checks (build the frontend first).

The original `frontend+backend` design is preserved and its data/actions now call `/api`. `npm run local` from the root serves the connected UI and an isolated backend. Swagger at `/api/docs/` uses provider key `local-test-key`; the server validates the local doctor account `rivera@demo.health` / `demo1234`. Patient/caregiver link forms check the patient's DOB (`2000-01-01` for local patients). The local backend uses in-memory SQLite and labeled AI/speech fixtures and captures email without sending. See [end-to-end testing instructions](../README.md). The normal AWS server still requires the team's resources and production provider sign-in is not configured: `/auth/login` returns 501 outside local mode.

`npm run local:ai` from the root loads ignored `backend/.env` and uses live AgentCore, Transcribe Medical streaming dictation, AI-Infra translation and ElevenLabs with persistent local SQLite stores in `.local-data`. See the root README for registration, the 30-day append rule and full feature browser checks.

## Precedence

The team's written backend tasks doc ("HealthHack Backend Tasks") is the contract: its five items ship here with its exact route names, query parameters, body keys and DynamoDB attribute names, typos included (`GET /llm-sumary?sum-id=`). Advik's Granola note comes next (SQL patient table, `GET /patients`, `POST /ingest` with a 202, the LLM call, DynamoDB storage and the patient email, translation on demand). The team architecture diagram fills in whatever both are silent on (`POST /synthesize`, `GET /p/:token`, S3 audio with the 30-day lifecycle, deletion receipts, light provider auth, Transcribe Medical). The real AWS resources override the names in all three: the table is `discharge-summaries`, the buckets are `emrpdf-rh` and `emraudio-rh`.

## Run it

```sh
cd backend && npm install && npm run dev
```

Node 24 (`.nvmrc`; `engines` is `>=24`). The server runs on the team's AWS account and has no local stand-ins: with AWS credentials in the shell (or an instance role on the team's EC2 box) it reads the team secret at boot and uses MariaDB on RDS, DynamoDB, S3, the AgentCore agent and Transcribe Medical. Swagger docs are at `http://localhost:4000/docs` (the raw spec at `/openapi.json`, both read from `openapi.yaml`); `npm run docs` also writes a standalone copy to `docs/swagger.html` that opens from disk (needs internet for Swagger UI; "Try it out" works only on the live `/docs`), and `npm run docs` rebuilds it after `openapi.yaml` changes.

What you must set: nothing beyond the machine's default AWS credentials (a local profile, or the instance role on the server). The standard chain is used; to pick a profile and region:

```sh
export AWS_PROFILE=<profile>
export AWS_REGION=us-west-2       # optional: this is the default (AWS_DEFAULT_REGION works too)
```

Those credentials let the server read `hackhealth/secret`, which supplies the RDS host, user and password and the DynamoDB table name and key, and they are what DynamoDB, S3, the agent and Transcribe use afterwards (the role needs the permissions under "Team infrastructure"). Every other variable below has a default. `DATABASE_URL` replaces the RDS values from the secret when the secret is out of reach, but DynamoDB, S3 and the agent still need the credentials. Change `PROVIDER_API_KEY` from its development default before anyone else can reach the server.

Patients come from the team's own table, `patientinfo` in the `dischargeai` database on RDS (the table `feature/infra-setup` reads with `SELECT * FROM patientinfo`). The backend reads it and can register patients through POST /patients, which requires INSERT permission. At startup it looks up the table's real column names and maps them to the nine `GET /patients` keys, ignoring case and underscores; the log line `patients table` shows the mapping, names only. The id column may be called `ID`, `patientID` or `uid`. The team's table on RDS has `uid, firstName, lastName, DOB, zipCode, phoneNumber, email, caregiverEmail` and no `caregiverName`, so `ID` is the `uid` value and `caregiverName` is `null`; a key whose column the table lacks is always `null`. If the table is missing or has no id column, startup stops and prints the columns it found.

RDS port 3306 must be reachable from where the server runs: outside the VPC it exits with `connect ETIMEDOUT`. See "Team infrastructure".

Nothing falls back to a local store. With no AWS credentials and no `DATABASE_URL` the server stops at startup with a message that says what is missing, and a missing RDS CA bundle stops it the same way. Export the AWS credentials in the terminal that starts the server (the terminal that runs curl needs none), and restart after every `git pull`: `npm run dev` restarts on file changes, `npm run start` does not. `curl -s localhost:4000/health` shows where everything points; `docStoreTarget` must say `dynamodb:us-west-2/discharge-summaries`.

```sh
npm run typecheck
npm run docs        # rebuild docs/swagger.html after editing openapi.yaml
```

## The team API (backend tasks doc)

Provider routes need the header `x-provider-key: dev-provider-key` (the `PROVIDER_API_KEY` default). Patient routes need no header; the 128-bit random `sumId` is the credential.

| Task | Route | What it does |
| --- | --- | --- |
| 1 | `GET /patients` (provider) | `{ "patients": [ { "ID", "DOB", "FirstName", "LastName", "ZipCode", "email", "phoneNumber", "caregiverEmail", "caregiverName" } ] }`, exactly those keys |
| 2 | `pdfToText` (`src/extract/pdfToText.ts`) | converts a PDF buffer to text; the ingester calls it for `type: "pdf"` |
| 3 | `POST /ingest` (provider) | JSON `{ "data", "type": "text" \| "pdf", "patientID" }`. Before it answers: a PDF is turned into text with `pdfToText` and stored in S3 `emrpdf-rh` (a PDF with no readable text answers `400 unreadable_pdf` and nothing is saved); the text, pasted or extracted, is saved on the DynamoDB item as `raw-text`; the random path `sumId` goes into the SQL `activeLinks` table and becomes the item's `uid`. Then it answers `202 { "statusCode": 202, "message": "ingestion started", "sumId", "link", "jobId", "expiresAt" }`. In the background: the text goes to the DischargeAI agent on AgentCore with the `sumId` as the session id and the call is awaited, the agent's whole response is saved on that item as `llm-summary` (with `sum-id`), and the link is emailed to the patient's `email` and `caregiverEmail` whatever status the agent gave. Nothing is translated. Any other `type` answers `400 { "statusCode": 400, "message": "type must be text or pdf" }` |
| 4 | `GET /llm-sumary?sum-id=` (patient) | the agent's response from the DynamoDB item, exactly as it came back; `/llm-summary` and `?sum_id=` work too |
| 5 | `GET /translation?lang=&sum_id=` (patient) | AI-Infra translation/verification when configured; 501 otherwise |

Errors on every route carry `{ "statusCode", "message" }`. Patient reads answer 404 unknown, 410 expired or deleted (checked at read time, before any sweeper runs), 425 while the agent is still working, 500 when the agent run failed.

## Test the five tasks with curl

Start the server in one terminal (AWS credentials exported, `cd backend && npm install && npm run dev`, Node 24), then paste these in another. Everything is inline JSON; nothing reads a local file. Replace `<ID>` with an `ID` from `GET /patients`.

### Task 1: `GET /patients`

```sh
# The rows of patientinfo, with exactly ID, DOB, FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/patients

# Without the provider key: 401 {"statusCode":401,...}
curl -s -w ' HTTP %{http_code}\n' http://localhost:4000/patients
```

### Task 2: `pdfToText`

The tasks doc defines it as a function the ingester calls, not a route, so it is tested by ingesting a PDF and reading the job. `POST /ingest` calls it before it answers, so the text is already on the DynamoDB item when the 202 comes back, and that same text is what the LLM receives. The `data` below is a one-page PDF (885 bytes) as base64:

```sh
# Ingest the PDF; the response carries the jobId and the sumId
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"pdf","patientID":"<ID>","data":"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMzQwID4+CnN0cmVhbQpCVAovRjEgMTEgVGYKMTQgVEwKNzIgNzIwIFRkCihEaXNjaGFyZ2UgZGlhZ25vc2lzOiBoZWFydCBmYWlsdXJlLikgVGoKVCogKE5ldyBtZWRpY2F0aW9uczopIFRqClQqICgtIEZ1cm9zZW1pZGUgNDAgbWcgYnkgbW91dGggb25jZSBkYWlseSBmb3Igc3dlbGxpbmcpIFRqClQqIChEaXNjaGFyZ2UgaW5zdHJ1Y3Rpb25zOikgVGoKVCogKC0gV2VpZ2ggeW91cnNlbGYgZXZlcnkgbW9ybmluZykgVGoKVCogKC0gRm9sbG93IHVwIHdpdGggY2FyZGlvbG9neSB3aXRoaW4gMSB3ZWVrKSBUagpUKiAoUmV0dXJuIHByZWNhdXRpb25zOikgVGoKVCogKC0gQ2FsbCA5MTEgZm9yIGNoZXN0IHBhaW4pIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo3MDIKJSVFT0YK"}' \
  http://localhost:4000/ingest

# Paste the jobId from that response: stage "done", meta.pdfPages 1, meta.pdfEngine "pdf-parse", meta.sourceChars 247
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/jobs/<jobId>

# Paste the sumId: the agent's Going-Home Plan built from the extracted text (it lists Furosemide 40 mg)
curl -s "http://localhost:4000/llm-sumary?sum-id=<sumId>"
```

The text goes to the DischargeAI agent, which writes the Going-Home Plan and reviews it itself; its verdict (`status`, `flags`) is part of the response the backend stores, and nothing is held back on it.

### Task 3: `POST /ingest`

```sh
# Text: 202 {"statusCode":202,"message":"ingestion started","sumId":...,"link":...,"jobId":...,"expiresAt":...}
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"text","patientID":"<ID>","data":"Discharge diagnosis: heart failure.\nNew medications:\n- Furosemide 40 mg by mouth once daily for swelling\nDischarge instructions:\n- Weigh yourself every morning\n- Follow up with cardiology within 1 week\nReturn precautions:\n- Call 911 for chest pain"}' \
  http://localhost:4000/ingest

# PDF: the task 2 command above (type "pdf", data = base64)

# Any other type: 400 {"statusCode":400,"error":"invalid_type","message":"type must be text or pdf"}
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"docx","patientID":"<ID>","data":"hello"}' http://localhost:4000/ingest

# Unknown patient: 404; no provider key: 401
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"text","patientID":"pt-9999","data":"hello"}' http://localhost:4000/ingest
curl -s -H "content-type: application/json" -d '{"type":"text","patientID":"<ID>","data":"hello"}' http://localhost:4000/ingest

# The activeLinks row: the patient now has an active link whose sumId matches the 202
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/patients/<ID>
```

The server terminal prints two emails with the link (the console transport; no sending identity is set up yet): one to the patient's `email` and one to their `caregiverEmail`. The job's progress is at `GET /jobs/<jobId>` (provider key), as in task 2.

### Task 4: `GET /llm-sumary?sum-id=`

These routes read the DynamoDB item, as the tasks doc says, and need no SQL row: an item written straight into the table (by a teammate's agent, or by hand) reads the same as one made by an ingest, judged by its own `status` and `expiresAt`. Use the `sumId` from a task 3 response (patient routes need no key). The agent takes from about 15 seconds to a few minutes after the 202: ask `GET /jobs/<jobId>` until `stage` is `done`, because a read before that answers `425 processing`.

```sh
# The agent's response saved on the DynamoDB item ("llm-summary": status, flags, summary, plan), with "sum-id", expiresAt and daysLeft
curl -s "http://localhost:4000/llm-sumary?sum-id=<sumId>"

# The same item on the correct spelling and with sum_id
curl -s "http://localhost:4000/llm-summary?sum_id=<sumId>"

# A well-formed id nobody issued: 404; no id: 400
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/llm-sumary?sum-id=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/llm-sumary"
```

To see day 30, stop the server and start it with the clock 31 days ahead and the purge timer off, then read the same `sumId` again: `410 link_expired`, decided at read time before anything is deleted. That summary stays expired after you restart normally, so ingest a fresh one for task 5.

```sh
DEMO_NOW=$(node -e 'console.log(new Date(Date.now()+31*864e5).toISOString())') PURGE_INTERVAL_MS=0 npm run dev
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/llm-sumary?sum-id=<sumId>"
```

While the agent is still working the route answers `425 processing`, so a read right after the 202 usually sees it.

### Task 5: `GET /translation?lang=&sum_id=`

Both /translation and /translate return the translation the AgentCore agent produced during ingest (`record.byLang` and `translations` in the stored response); nothing is translated at request time. Use lang=en/es/zh/ar and sum_id. Non-English responses include translatedPlan, translationStatus and translationProblems, and answer 404 when the stored plan has no translation for that language (for example a fixture plan). Example:

```sh
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/translation?lang=es&sum_id=<sumId>"
```

## Public surface

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/health` | anyone | clock, configuration source, and where each provider and store points |
| GET | `/patients` | provider | task 1; takes no parameters and returns the whole table, sorted by last then first name |
| POST | `/patients` | provider | Register ID/DOB, or match an existing patient; mismatched DOB returns 409 |
| GET | `/patients/:id` | provider | one patient, with the active link once generated |
| POST | `/ingest` | provider | task 3; translates nothing. Multipart `patientId` + one of `text`, `file` (PDF), `audio` is kept as an alias (audio comes from the diagram; it is transcribed in the background first, the only input whose text does not exist before the answer) |
| GET | `/jobs/:jobId` | provider | follow the 202: stage and run metadata (the agent's run time) |
| POST | `/synthesize` | provider | re-run the agent. `{ text }` sends the text to the agent in a fresh session and returns its response without storing anything; `{ sumId }` (or `linkId`) sends the stored raw text again, with the sum-id as the session id, replaces `llm-summary` and emails the patient if the link had not been sent |
| GET | `/llm-sumary?sum-id=` | patient | task 4; also `/llm-summary`, `?sum_id=` |
| GET | `/translation?lang=&sum_id=` | patient | task 5; AI-Infra translation when configured (501 otherwise) |
| GET | `/p/:token` | patient | the diagram's patient page, the same body as task 4 |
| GET | `/summary?link=`, `/translate` | patient | earlier spellings of tasks 4 and 5 |
| GET | `/docs`, `/openapi.json` | anyone | OpenAPI 3.0.3, Swagger UI |

`llm-summary` is whatever the agent returned, stored and served without anything added or removed. On the live runtime (`agentcore_app.py` on the `AI-Infra` branch, request `{"notes": "<clinician text>"}`) that is:

```
{ status: approved | needs_clinician_check | needs_human_review, flags: [...],
  summary: "<Going-Home Plan, Markdown>", plan: { why_in_hospital, schedule, new_medicines, changed_medicines,
  stopped_medicines, tests, appointments, care_instructions, questions_for_care_team, call_doctor_if, get_help_now_if } }
```

The `sumId` is 43 characters (256 random bits) because it is also the AgentCore session id, which must be at least 33.

## Where each piece lives

| Piece | Files |
| --- | --- |
| Light provider auth | `src/middleware/providerAuth.ts` (`x-provider-key`, constant-time compare) |
| `POST /ingest`, 202, async job | `src/routes/ingest.ts`, `src/pipeline/ingestJob.ts`, `src/pipeline/queue.ts` |
| PDF to text | `src/extract/pdfToText.ts` (`pdfToText`, pdf-parse with a pdfjs fallback), `src/extract/text.ts` |
| PDF and audio objects | `src/data/objects.ts` (S3 `emrpdf-rh` / `emraudio-rh`), `src/data/s3/objects.ts`, `scripts/setup-s3.ts` |
| The random path (`sumId`) | `src/crypto/sumId.ts` (256 random bits, base64url, 43 characters; also the AgentCore session id) |
| SQL: the team's `patientinfo` (read only), `activeLinks`, `jobs`, `audit_log` | `src/db/migrations/0001_init.sql`, `0002_patientinfo.mysql.sql`, `0003_drop_ingest_language.sql` (drops the ingest-time `language` column from `activeLinks`), `0004_long_sum_ids.sql` (widens the three sum-id columns to 64 characters for the 43-character ids; it runs on the first start of this version, including on the shared RDS), `src/db/repos/{patients,activeLinks,jobs,audit}.ts` (column discovery in `patients.ts`), MariaDB via `src/db/index.ts` (`MySqlDb`) |
| DynamoDB `discharge-summaries`, one item per summary | `src/docstore/dynamo.ts`, item type `src/docstore/types.ts`, `scripts/setup-dynamo.ts` |
| Speech to text (Transcribe Medical) | `src/pipeline/speechToText.ts`, `src/pipeline/transcribe/medical.ts` |
| The DischargeAI agent on AgentCore | `src/pipeline/agent.ts` (`InvokeAgentRuntime`, body `{"notes"}`, session id = the sum-id, never retried, `AGENT_TIMEOUT_MS`), called from `synthesizeLink` in `src/pipeline/ingestJob.ts` |
| Patient reads, translation stub | `src/routes/{llmSummary,patientLink,summary,translation}.ts`, shared `src/routes/linkAccess.ts` |
| Email the patient and the caregiver (console, SMTP, SES, optional SQS + worker) | `src/email/{mailer,templates,queue}.ts`, `emailLinks` in `src/pipeline/ingestJob.ts`, `scripts/email-worker.ts` |
| Day 30: read-time expiry, purge, DynamoDB TTL, S3 lifecycle | `src/routes/linkAccess.ts` (410 at read time), `src/pipeline/purge.ts`, `scripts/sweep.ts` |
| Deletion receipts | `src/audit/receipts.ts` (sql and dynamo sinks), `scripts/show-audit.ts` |
| Configuration from the team secret | `src/secrets.ts`, `src/bootstrap.ts` |
| OpenAPI and Swagger docs | `openapi.yaml` (the one source), `src/app.ts` (serves `/docs` and `/openapi.json`), `scripts/swagger-docs.ts` (`npm run docs` builds the standalone `docs/swagger.html`) |

## Team infrastructure

Region `us-west-2`, account `183815333909`. All of it is wired in; the backend reads the secret at boot and uses these resources.

- Secrets Manager secret `hackhealth/secret`, ARN `arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q`. Keys: `dynamodb-table` (`discharge-summaries`), `dynamodb-table-pk` (`uid`), `mysql-host`, `mysql-port` (3306), `mysql-user` (`admin`), `mysql-password`, `mysql-db` (`dischargeai`, the database to use; the tables are created inside it). The password and the database name come only from the secret at runtime; they are never in a file, a log, a test or this README. `/health` reports which variables came from the secret, by name.
- RDS instance `patients`: MariaDB, `db.t4g.micro`, endpoint `patients.cleqcmkoulma.us-west-2.rds.amazonaws.com`, port 3306, user `admin`, IAM authentication enabled, security group open on 3306. The AWS console's connection steps:
  1. `curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` (`npm run fetch-rds-bundle` runs exactly this into `certs/`; a copy of the public bundle is committed, byte-identical to that download on 2026-10-10, 111 certificates, and to the one on `feature/infra-setup`).
  2. `mysql -h patients.cleqcmkoulma.us-west-2.rds.amazonaws.com -P 3306 -u admin -p"$(aws secretsmanager get-secret-value --secret-id 'arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q' --query SecretString --output text | jq -r '.["mysql-password"]')" --ssl-verify-server-cert --ssl-ca=./global-bundle.pem` (the console's own snippet reads the RDS-managed master secret with `jq -r '.password'` instead; both work, the password is never pasted).
  The backend does the same over `mysql2`: `ssl: { ca: <certs/global-bundle.pem>, rejectUnauthorized: true }`, a connection pool, `CREATE DATABASE IF NOT EXISTS dischargeai`, then the migrations. The bundle path (`RDS_CA_BUNDLE`) is read from `backend/` wherever the server is started, and a missing or empty bundle stops the connection with the curl command above; there is no fallback to other certificates. Either let the secret drive it, or set `DATABASE_URL=mysql://admin:<password>@patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306/dischargeai`. `npm run check-sql` connects, migrates and prints the server version, table counts, and the `patientinfo` columns with how they map and its row count (names and counts, never values).
- Table `patientinfo` in `dischargeai`: the team's patient list. The backend reads it for `GET /patients`, `GET /patients/:id`, and the patient's `email` and `caregiverEmail` at ingest; it never writes to it. The migrations create it only where no table of that name exists (a fresh database).
- Upgrading a database the earlier backend (before the tasks doc) migrated: that version created its own `patients` (holding the six synthetic patients it seeded), `links`, `jobs`, `audit_log` and `documents`, and recorded `0001_init.sql`. On the first start of this version those five tables are renamed to `<name>_pre_contract` with their rows kept, their foreign keys dropped (MariaDB foreign key names are database-wide and `fk_jobs_link` is reused), and the current schema is built; the log line `pre-contract tables set aside` lists every change. Nothing is deleted. When nobody needs them: `DROP TABLE documents_pre_contract, jobs_pre_contract, audit_log_pre_contract, links_pre_contract, patients_pre_contract;`
- DynamoDB table `discharge-summaries`: hash key `uid` (string), no sort key, TTL enabled on `expiresAt` (epoch seconds). One item per summary: `uid` = `sumId`, `sum-id` (the same value), `patientID`, `raw-text`, `llm-summary` (the agent's whole response), `status` (`processing`, `ready` or `failed`), `createdAt`, `expiresAt`, plus the backend's own `inputKind`, `pdfKey`/`audioKey` and `meta`. The attributes are plain so teammates can read them; DynamoDB encrypts the table at rest. `npm run setup-dynamo` creates the table when missing and enables TTL, idempotently.
- S3 bucket `emrpdf-rh`: uploaded PDFs under `<sumId>.pdf` with SSE-S3 (AES256). `npm run setup-s3` creates it when missing and makes sure it blocks public access, encrypts by default and expires objects after 30 days (`-- --check` only reports; `-- --bucket <name>` limits it to one bucket).
- S3 bucket `emraudio-rh`: audio clips under `<sumId>.<ext>` with SSE-S3. It already carries the lifecycle rule `autodelete` (expire after 30 days, abort incomplete multipart uploads after 30 days), which `npm run setup-s3` leaves alone.
- AgentCore Runtime `DischargeAIAgent_DischargeAI-y8mQ6FEN5u` (`arn:aws:bedrock-agentcore:us-west-2:183815333909:runtime/DischargeAIAgent_DischargeAI-y8mQ6FEN5u`, endpoint DEFAULT): the team's DischargeAI agent from the `AI-Infra` branch. The live entrypoint is `agentcore_app.py`, which reads `{"notes"}` and answers `{status, flags, summary, plan}` (checked on 2026-10-11 in the runtime's CloudWatch log).

The `sumId` is stored as-is in `activeLinks`, as the DynamoDB `uid` and in the object keys, because the tasks doc has teammates join on it. It is also the patient's credential, so access to the table and the buckets stays limited to the team role.

IAM the backend needs: `secretsmanager:GetSecretValue` on the secret; `dynamodb:PutItem, GetItem, UpdateItem, DeleteItem, Scan` on the table plus `DescribeTable, DescribeTimeToLive, UpdateTimeToLive, CreateTable` for the setup script; `bedrock-agentcore:InvokeAgentRuntime` on `AGENT_RUNTIME_ARN`; `s3:PutObject, GetObject, DeleteObject, ListBucket` on `emrpdf-rh` and `emraudio-rh` (plus `CreateBucket, PutPublicAccessBlock, PutEncryptionConfiguration, GetLifecycleConfiguration, PutLifecycleConfiguration` for the setup script); `ses:SendEmail` when `EMAIL_TRANSPORT=ses`; `sqs:SendMessage` (and `ReceiveMessage, DeleteMessage` for the worker) when `EMAIL_QUEUE=sqs`; `transcribe:StartMedicalTranscriptionJob, GetMedicalTranscriptionJob` for dictated audio.

### Verified on 2026-10-10 and 2026-10-11 UTC (build container, Workshop Studio role)

On 2026-10-11, after the local stores, offline providers, test suite, fixtures and sample scripts were removed (restore point `b2582f1`), the project was typechecked on Node 24.21 and booted against the real Secrets Manager secret, DynamoDB, S3 and Bedrock, with a throwaway MariaDB 10.11 that requires TLS standing in for RDS (RDS port 3306 is not reachable from the build container; the database came from `DATABASE_URL` and a private CA from `RDS_CA_BUNDLE`). It connected with `rejectUnauthorized` on, built the schema next to a team-shaped `patientinfo` (`uid` INT id, DATE `DOB`, no `caregiverName`), ingested text and a PDF (Sonnet 4.6, job `done` and verified, the PDF in `emrpdf-rh`), read the summary back, translated into Spanish (miss, then hit) and answered the 400 and 404 cases. Every curl block in "Test the five tasks" was also run as written, waiting for each job to finish, and returned the status shown there (the `DEMO_NOW` restart block in task 4 restarts the server and was not run). The items and PDFs it created were deleted by key afterwards. It also refused to start with no database configured, with the AWS bundle against the private CA (`self-signed certificate in certificate chain`) and with a missing bundle. The earlier live checks below used the team secret and `LLM_PROVIDER=bedrock`.

Later on 2026-10-11, after the switch to the AgentCore agent, the same setup ran the new migration `0004_long_sum_ids.sql` on that existing database (old rows kept, the three sum-id columns now 64 wide, the foreign key back) and on a fresh one, and a text ingest went through the live agent: job `done` in about 24 s, `llm-summary` held `status, flags, summary, plan` (status `approved`) and `GET /llm-sumary` returned exactly what DynamoDB held, the emails printed to the patient and the caregiver, `/llm-summary`, `/summary` and `/p/:token` answered 200, `/translation` and `/translate` 501, a 22-character id 400 and an unknown 43-character id 404. `POST /synthesize` re-ran the stored summary in the same session (16 s) and ran fresh text in a new session (21 s). Every curl block in "Test the five tasks" was then run again as written against the live agent, waiting for each job, and returned the status shown there (the `DEMO_NOW` restart block excepted). The test items and PDFs were deleted afterwards.

| Check | Result |
| --- | --- |
| Secrets Manager `GetSecretValue` | all seven keys read and applied (406 ms) |
| DynamoDB `discharge-summaries` | ACTIVE, hash key `uid`, TTL on `expiresAt`; probe put 84 ms, get 65 ms, delete 71 ms |
| S3 `emraudio-rh` | probe object put with SSE AES256, read, delete; lifecycle rule `autodelete` (30 days) present |
| S3 `emrpdf-rh` | did not exist; created by `npm run setup-s3 -- --bucket emrpdf-rh` (public access blocked, AES256, 30-day expiry); a second run changed nothing |
| Swagger page | `docs/swagger.html` rendered in headless Chromium with Swagger UI 5.33.1 served from a local copy (the page itself loads it from jsDelivr): the title, all 12 operations and no page errors. Not opened with the real CDN from the build container |
| Cleanup | each live run's item and PDF were deleted by key and confirmed gone |
| MariaDB 10.11 over TLS (stand-in for RDS) | the boot described above; before the suite was removed, the pre-contract upgrade, a `patientinfo` with an INT id and a DATE column, and `activeLinks` rows also ran against MariaDB 10.11.14 (134 of 134 tests on 2026-10-11) |

### Needs a key or not exercised live from the build container

| Item | State |
| --- | --- |
| MySQL/MariaDB on RDS over port 3306 | port 3306 is not reachable from the build container, so RDS itself is not exercised from there, and the AWS bundle was not tried against the real server (a private CA was, see above). Run `npm run check-sql` from a host that reaches RDS |
| Amazon SES (`EMAIL_TRANSPORT=ses`), SMTP | transports construct; no sending identity here, so emails print to the console |
| SQS email queue and `scripts/email-worker.ts` | producer and worker written; no queue URL here |
| Amazon Transcribe Medical | adapter reads the clip from the bucket by key and polls the job; not run here |


## Configuration

Copy `.env.example` to `.env`. The defaults point at the team account.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST`, `LOG_LEVEL` | `4000`, `0.0.0.0`, `info` | server |
| `PATIENT_APP_URL` | `http://localhost:5173` | links look like `${PATIENT_APP_URL}/s/<sumId>` |
| `PROVIDER_API_KEY` | `dev-provider-key` | the `x-provider-key` value |
| `DEMO_NOW` | unset | pins the app clock to an ISO moment at boot (day-30 demos); never in production |
| `PURGE_INTERVAL_MS` | `60000` | purge timer; `0` disables it (`npm run sweep` runs it once) |
| `DEMO_PURGE_ON_AWS` | `no` | with `DEMO_NOW` set, the purge refuses to run against DynamoDB or S3; `yes` allows it on a throwaway account only |
| `SECRETS_BOOTSTRAP`, `AWS_SECRET_ARN`, `AWS_REGION` | `auto`, the team ARN, `us-west-2` | read the secret at boot when credentials resolve; `off` never calls AWS |
| `DATABASE_URL` | unset | `mysql://user:password@host:3306/db`; wins over `MYSQL_*` and the secret |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_POOL_SIZE` | from the secret, `dischargeai`, `5` | MariaDB on RDS; used when `DATABASE_URL` is unset |
| `RDS_CA_BUNDLE` | `certs/global-bundle.pem` | AWS connection step 1; required for MySQL; relative paths are read from `backend/` |
| `PATIENTS_TABLE` | `patientinfo` | the team's patient table, read only |
| `DYNAMO_TABLE`, `DYNAMO_PK` | `discharge-summaries`, `uid` | the DynamoDB table (from the secret) |
| `PDF_BUCKET` | `emrpdf-rh` | the S3 bucket for PDFs |
| `AUDIO_BUCKET` | `emraudio-rh` | the S3 bucket for dictated audio |
| `AUDIT_SINK` | `sql` | where deletion receipts go: the `audit_log` table, or `receipt#` items in the DynamoDB table |
| `AGENT_RUNTIME_ARN`, `AGENT_QUALIFIER`, `AGENT_TIMEOUT_MS` | the DischargeAI runtime, unset (DEFAULT endpoint), `900000` | the AgentCore agent that writes `llm-summary`, the endpoint to call, and how long one run may take before the job fails |
| `TRANSCRIBE_OUTPUT_BUCKET` | unset (the audio bucket) | where Transcribe Medical writes transcripts |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SMTP_URL` | `console`, a placeholder, unset | console prints the message; `smtp`; `ses` |
| `EMAIL_QUEUE`, `SQS_QUEUE_URL` | `none`, unset | `sqs` enqueues instead of sending; `npm run email-worker` consumes |
| `MAX_UPLOAD_BYTES` | 15 MB | PDF and audio limit (a base64 PDF in JSON may be about 1.4 times that) |

Scripts: `dev`, `start`, `typecheck`, `sweep`, `show-audit`, `check-sql`, `fetch-rds-bundle`, `setup-dynamo`, `setup-s3`, `ensure-s3-lifecycle`, `email-worker`, `docs`.

## How the data lives and dies

SQL (MariaDB on RDS): the team's `patientinfo` (read only), `activeLinks` (`id`, `sumId`, `patientID`, `createdAt`, `expiresAt = createdAt + 30 days`, `status`, plus object keys, viewed-at and emailed-at), `jobs` (the stage machine and metadata), `audit_log` (events and deletion receipts, never PHI). One portable schema; `src/db/migrate.ts` rewrites the few MySQL-specific tokens.

DynamoDB: one item per summary as described under "Team infrastructure".

Day 30 has four layers, from the fastest to the backstop:

1. Read time: every patient route compares `expiresAt` with the app clock and answers 410 before serving anything.
2. The purge job (`PURGE_INTERVAL_MS`, `npm run sweep`): deletes the summary item and the PDF or audio object with one deletion receipt each, marks the link purged. `DEMO_NOW=<31 days ahead> npm run sweep` runs it once on a shifted clock; with `DEMO_NOW` set it refuses to run (it would delete teammates' recent data in DynamoDB and S3) unless `DEMO_PURGE_ON_AWS=yes` on a throwaway account. `npm run show-audit -- --receipts` prints the receipts.
3. DynamoDB TTL on `expiresAt` and the S3 lifecycle rules delete whatever is left on AWS (no receipt is written for those deletions).
4. The backstop sweep inside the purge job deletes any item past its `expiresAt` that the per-link loop did not reach, with receipts.

Receipts say what was deleted (the item `uid` or the object key), when, by which mechanism (`purge_job`) and for which summary, and they outlive the data.

## Safety and what stays under human control

- The agent reviews its own plan and says so in the response (`status`, `flags`). The backend adds no second check: every completed summary is shown and emailed whatever the agent's status, including `needs_clinician_check` and `needs_human_review`.
- The backend never writes anyone's words. The agent rephrases the clinician's own discharge instructions for the patient and speaks as itself; nothing here drafts a message, note or reply for a person to send as their own.
- No PHI in logs (pino redaction; logs carry an 8-character hash of the sumId, never the id), in the audit log, in receipts, or in error bodies.
- The provider key is light auth for a hackathon front end; the patient credential is the 128-bit sumId, rate limited.

## What `alt-backend` adds

The other branch of this repo (`alt-backend`) keeps surfaces this branch leaves out, as its OpenAPI listed them on 2026-10-10: the patient checklist (`GET /checklist`, `POST /checklist/complete`), the demo clock and purge endpoints under `/admin/*`, `GET /languages`, `GET /audit` and `GET /audit/receipts`, `GET /contracts`, extra keys on each step such as `category` and `due`, and per-link encryption keys destroyed at expiry. This branch folds the language list into OpenAPI, moves the demo clock to `DEMO_NOW` plus `npm run sweep`, and prints the audit log with `npm run show-audit`.

## What this branch leaves out

No automated tests, fixtures, demo or sample scripts, local stores (SQLite, a SQL copy of the DynamoDB table, local PDF and audio folders), offline AI providers, standalone Lambda handlers or published contract files: all removed on 2026-10-11 to leave the running project. The last commit that has them is `b2582f1`; `git checkout b2582f1 -- backend` brings the project back as it was, tests included (134 tests, vitest and supertest).

## Limitations

The MariaDB path is written against the mysql2 API and was exercised on a local MariaDB 10.11 over TLS, not against RDS from the build container (see the table above). If sending an email fails after the summary was saved, the whole job and link are marked failed even though `llm-summary` is on the item, and the job queue is in memory. Per-patient listing in DynamoDB is a filtered scan. No check runs between the agent and the patient: whatever the agent returns is shown and emailed. The jobs run one at a time, so an ingest waits for the agent runs ahead of it. Dictated audio goes through Transcribe Medical and has not been run end to end.

## Open for the team

- Run `npm run check-sql` from the EC2 host that reaches RDS on 3306 and confirm the migrations on MariaDB (not reachable from the build container).

- Dictate one clip end to end through Transcribe Medical on the EC2 box.
- The `discharge-summaries` table was recreated on 2026-10-11 at 01:42 UTC with TTL disabled, so DynamoDB's own 30-day deletion is off until `npm run setup-dynamo` (or the console) enables TTL on `expiresAt` again; the purge job still deletes expired items meanwhile.
- The agent's prompts and graph live on the `AI-Infra` branch; after a change there, `POST /synthesize { sumId }` re-runs a stored summary.
- Translation (task 5): the AgentCore agent translates into en/es/zh/ar during ingest; the route returns that stored plan.
- `backend/src/dischargeAgent.js` on the `AI-Infra` branch sends `{"prompt"}` and expects `{result}`, but the deployed runtime runs `agentcore_app.py`, which reads `{"notes"}` and returns `{status, flags, summary, plan}`. This backend sends `notes`.
- Front end: render `llm-summary` from `GET /p/:token` (the agent's `summary` Markdown or its `plan` sections); the email link is `${PATIENT_APP_URL}/s/<sumId>`.
