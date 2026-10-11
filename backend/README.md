# DischargeAI backend

A clinician hands over a discharge summary (pasted text, a PDF, or dictated audio). The DischargeAI agent on Amazon Bedrock AgentCore Runtime turns it into a plain-language Going-Home Plan, the patient and their caregiver get an emailed link to it, and every piece of data deletes itself 30 days after it was created.

Node 24, TypeScript, Express 5, on AWS: MariaDB on RDS, DynamoDB, S3, Bedrock AgentCore, Transcribe Medical, Secrets Manager.

## How it works

1. `POST /ingest` takes the summary. A PDF is converted to text first (and the file stored in S3); audio is transcribed by Transcribe Medical in the background.
2. The server answers `202` right away with a `sumId`, the patient link, and a `jobId`. The `sumId` is 256 random bits and is the patient's only credential.
3. In the background the text goes to the DischargeAI agent, which writes the plan and reviews it itself. Its whole response is stored on the summary's DynamoDB item as `llm-summary`.
4. The link is emailed to the patient's `email` and `caregiverEmail`.
5. The link (`${PATIENT_APP_URL}/s/<sumId>`) opens the patient app, which reads the plan from `GET /llm-sumary?sum-id=<sumId>` or `GET /p/<sumId>`.
6. On day 30 the link stops working at read time (`410`), and the summary, the PDF or audio, and the record are deleted, each deletion leaving a receipt that contains no patient data.

The agent's response looks like:

```
{ status: approved | needs_clinician_check | needs_human_review, flags: [...],
  summary: "<Going-Home Plan, Markdown>",
  plan: { why_in_hospital, schedule, new_medicines, changed_medicines, stopped_medicines, tests,
          appointments, care_instructions, questions_for_care_team, call_doctor_if, get_help_now_if } }
```

## Run it

You need Node 24 (`.nvmrc`) and AWS credentials for the account that holds the DischargeAI resources. There are no local stand-ins: without AWS the server stops at startup and prints what's missing.

```sh
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...      # only with temporary credentials
export AWS_REGION=us-west-2       # optional, this is the default

cd backend
npm install
npm run dev
```

The server listens on `http://localhost:4000`. At boot it reads the Secrets Manager secret `hackhealth/secret`, which supplies the RDS and DynamoDB settings; every other variable has a default (see Configuration). A profile or an instance role works in place of exported keys.

Check it came up:

```sh
curl -s localhost:4000/health
```

`docStoreTarget` should read `dynamodb:us-west-2/discharge-summaries`. Interactive API docs are at `http://localhost:4000/docs` (the raw OpenAPI spec is at `/openapi.json`).

RDS port 3306 has to be reachable from wherever the server runs; if it isn't, startup exits with `connect ETIMEDOUT`. `npm run check-sql` tests the database connection on its own.

`npm run dev` restarts on file changes; `npm run start` runs without the watcher.

## Try it with curl

Start the server in one terminal, then run these in another. Provider routes need the header `x-provider-key: dev-provider-key`; patient routes need nothing but the `sumId`.

List patients and pick an `ID`:

```sh
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/patients
```

Ingest a discharge summary as text (replace `<ID>`):

```sh
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"text","patientID":"<ID>","data":"Discharge diagnosis: heart failure.\nNew medications:\n- Furosemide 40 mg by mouth once daily for swelling\nDischarge instructions:\n- Weigh yourself every morning\n- Follow up with cardiology within 1 week\nReturn precautions:\n- Call 911 for chest pain"}' \
  http://localhost:4000/ingest
```

The answer is `202 {"statusCode":202,"message":"ingestion started","sumId":...,"link":...,"jobId":...,"expiresAt":...}`. The agent takes roughly 15 seconds to a few minutes. Follow the job until `stage` is `done`:

```sh
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/jobs/<jobId>
```

Then read what the patient sees:

```sh
curl -s "http://localhost:4000/llm-sumary?sum-id=<sumId>"
```

Reading before the job is done answers `425 processing`. The server terminal prints the two emails with the link (the default email transport is the console).

To ingest a PDF instead, send `"type":"pdf"` with the file as base64 in `data`:

```sh
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"pdf","patientID":"<ID>","data":"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMzQwID4+CnN0cmVhbQpCVAovRjEgMTEgVGYKMTQgVEwKNzIgNzIwIFRkCihEaXNjaGFyZ2UgZGlhZ25vc2lzOiBoZWFydCBmYWlsdXJlLikgVGoKVCogKE5ldyBtZWRpY2F0aW9uczopIFRqClQqICgtIEZ1cm9zZW1pZGUgNDAgbWcgYnkgbW91dGggb25jZSBkYWlseSBmb3Igc3dlbGxpbmcpIFRqClQqIChEaXNjaGFyZ2UgaW5zdHJ1Y3Rpb25zOikgVGoKVCogKC0gV2VpZ2ggeW91cnNlbGYgZXZlcnkgbW9ybmluZykgVGoKVCogKC0gRm9sbG93IHVwIHdpdGggY2FyZGlvbG9neSB3aXRoaW4gMSB3ZWVrKSBUagpUKiAoUmV0dXJuIHByZWNhdXRpb25zOikgVGoKVCogKC0gQ2FsbCA5MTEgZm9yIGNoZXN0IHBhaW4pIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo3MDIKJSVFT0YK"}' \
  http://localhost:4000/ingest
```

To watch day 30 arrive, restart the server with the clock 31 days ahead and the purge timer off, then read the same `sumId` again. It answers `410 link_expired`. That summary stays expired after a normal restart, so ingest a fresh one afterwards.

```sh
DEMO_NOW=$(node -e 'console.log(new Date(Date.now()+31*864e5).toISOString())') PURGE_INTERVAL_MS=0 npm run dev
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/llm-sumary?sum-id=<sumId>"
```

## API

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/health` | anyone | clock, configuration source, and where each store points |
| GET | `/patients` | provider | every patient, sorted by last then first name |
| GET | `/patients/:id` | provider | one patient, with their active link once one exists |
| POST | `/ingest` | provider | JSON `{ "data", "type": "text" \| "pdf", "patientID" }`; also multipart `patientId` plus one of `text`, `file` (PDF), `audio` |
| GET | `/jobs/:jobId` | provider | progress of an ingest |
| POST | `/synthesize` | provider | `{ text }` runs the agent on any text and returns its response without storing it; `{ sumId }` re-runs a stored summary and replaces `llm-summary` |
| GET | `/llm-sumary?sum-id=` | patient | the stored plan; `/llm-summary` and `?sum_id=` also work |
| GET | `/p/:token` | patient | the same plan, by path |
| GET | `/translation?lang=&sum_id=` | patient | not built yet, answers `501` |
| GET | `/docs`, `/openapi.json` | anyone | Swagger UI and the OpenAPI 3.0.3 spec |

Errors carry `{ "statusCode", "message" }`. Patient reads answer `404` for an unknown id, `410` once expired or deleted, `425` while the agent is working, and `500` if the agent run failed.

## Privacy and the 30-day lifecycle

Every record carries an `expiresAt` 30 days after creation, enforced in four layers:

1. Read time: every patient route checks `expiresAt` and answers `410` before serving anything.
2. The purge job (every `PURGE_INTERVAL_MS`, or once with `npm run sweep`) deletes the summary item and its PDF or audio and writes a deletion receipt for each. `npm run show-audit -- --receipts` prints them.
3. DynamoDB TTL on `expiresAt` and the S3 lifecycle rules delete anything left on AWS.
4. A backstop sweep inside the purge job catches any expired item the per-link pass missed.

Receipts record what was deleted, when, and by what mechanism, and they outlive the data. No patient data goes into logs (redacted; logs carry an 8-character hash of the `sumId`), the audit log, receipts, or error bodies. Uploaded PDFs and audio are written to S3 with server-side encryption.

The agent checks its own plan and reports the result as `status` and `flags`. The backend shows and emails every completed plan whatever that status is, so the status is there for a clinician to act on.

## Configuration

Copy `.env.example` to `.env` to override anything. Defaults point at the DischargeAI AWS resources.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST`, `LOG_LEVEL` | `4000`, `0.0.0.0`, `info` | server |
| `PATIENT_APP_URL` | `http://localhost:5173` | links look like `${PATIENT_APP_URL}/s/<sumId>` |
| `PROVIDER_API_KEY` | `dev-provider-key` | the `x-provider-key` value; change it before exposing the server |
| `DEMO_NOW` | unset | pins the app clock to an ISO moment at boot, for the day-30 walkthrough |
| `PURGE_INTERVAL_MS` | `60000` | purge timer; `0` turns it off |
| `DEMO_PURGE_ON_AWS` | `no` | with `DEMO_NOW` set the purge refuses to touch DynamoDB or S3 unless this is `yes` |
| `SECRETS_BOOTSTRAP`, `AWS_SECRET_ARN`, `AWS_REGION` | `auto`, the DischargeAI secret, `us-west-2` | read the secret at boot when credentials resolve; `off` never calls AWS |
| `DATABASE_URL` | unset | `mysql://user:password@host:3306/db`; wins over `MYSQL_*` and the secret |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_POOL_SIZE` | from the secret, `dischargeai`, `5` | used when `DATABASE_URL` is unset |
| `RDS_CA_BUNDLE` | `certs/global-bundle.pem` | RDS TLS bundle (`npm run fetch-rds-bundle` downloads it) |
| `PATIENTS_TABLE` | `patientinfo` | the patient table, read only |
| `DYNAMO_TABLE`, `DYNAMO_PK` | `discharge-summaries`, `uid` | one item per summary |
| `PDF_BUCKET`, `AUDIO_BUCKET` | `emrpdf-rh`, `emraudio-rh` | S3 buckets for uploads |
| `AUDIT_SINK` | `sql` | deletion receipts in the `audit_log` table, or `dynamo` |
| `AGENT_RUNTIME_ARN`, `AGENT_QUALIFIER`, `AGENT_TIMEOUT_MS` | the DischargeAI runtime, DEFAULT endpoint, `900000` | the AgentCore agent that writes the plan |
| `TRANSCRIBE_OUTPUT_BUCKET` | the audio bucket | where Transcribe Medical writes transcripts |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SMTP_URL` | `console`, a placeholder, unset | `console` prints, `smtp`, or `ses` |
| `EMAIL_QUEUE`, `SQS_QUEUE_URL` | `none`, unset | `sqs` queues emails; `npm run email-worker` sends them |
| `MAX_UPLOAD_BYTES` | 15 MB | PDF and audio limit |

Scripts: `dev`, `start`, `typecheck`, `docs` (rebuilds `docs/swagger.html` from `openapi.yaml`), `check-sql`, `fetch-rds-bundle`, `setup-dynamo`, `setup-s3`, `ensure-s3-lifecycle`, `sweep`, `show-audit`, `email-worker`.

`npm run setup-dynamo` creates the DynamoDB table with TTL on `expiresAt` if it's missing; `npm run setup-s3` creates the buckets with public access blocked, default encryption and 30-day expiry. Both are safe to re-run.

## Code map

| Piece | Files |
| --- | --- |
| Ingest, the 202 and the background job | `src/routes/ingest.ts`, `src/pipeline/ingestJob.ts`, `src/pipeline/queue.ts` |
| PDF to text | `src/extract/pdfToText.ts` |
| Speech to text | `src/pipeline/speechToText.ts`, `src/pipeline/transcribe/medical.ts` |
| The AgentCore agent call | `src/pipeline/agent.ts` |
| Patient reads and expiry | `src/routes/{llmSummary,patientLink,summary,translation}.ts`, `src/routes/linkAccess.ts` |
| The `sumId` | `src/crypto/sumId.ts` |
| SQL (patients, links, jobs, audit) | `src/db/`, migrations in `src/db/migrations/` |
| DynamoDB | `src/docstore/dynamo.ts` |
| S3 | `src/data/objects.ts`, `src/data/s3/objects.ts` |
| Email | `src/email/`, `scripts/email-worker.ts` |
| Purge and receipts | `src/pipeline/purge.ts`, `src/audit/receipts.ts`, `scripts/sweep.ts` |
| Provider auth | `src/middleware/providerAuth.ts` |
| Configuration from Secrets Manager | `src/secrets.ts`, `src/bootstrap.ts` |
| API spec | `openapi.yaml` |

## Limitations

- Translation isn't built: `/translation` answers `501`.
- Ingest jobs run one at a time from an in-memory queue, so a new ingest waits for the agent runs ahead of it.
- If the email fails after the plan was saved, the job is marked failed even though the plan is stored.
- Dictated audio through Transcribe Medical hasn't been run end to end.
- Email prints to the console until an SES or SMTP sender is configured.
- Provider auth is a single shared key.
