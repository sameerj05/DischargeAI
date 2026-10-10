# DischargeAI backend: requirements (Kiro spec), branch `alt-backend`

Precedence (Advik, 10 Oct 2026): the Granola API note is the source of truth; the team architecture diagram fills in what the note is silent on; the real AWS resources (Secrets Manager `hackhealth/secret`, RDS MariaDB `patients`, DynamoDB `discharge-summaries` with hash key `uid`, S3 `emraudio-rh`) override names in both. Where the note and the diagram conflict, the note wins.

Scope: everything under `backend/` on branch `alt-backend` of `sameerj05/DischargeAI`. The backend owns the SQL patient database, every API endpoint, and the document-store (DynamoDB) read/write logic. Teammates own the plain-language simplification prompt and the translation agent; the backend ships a working default for both behind an interface so the whole product demos end to end today.

Challenge brief (Rutgers Health Hack 2026, Ops Unleashed, Challenge 1 "Discharge AI"): capture complex clinical discharge instructions (audio or EMR text), turn them into plain language and the patient's native tongue, host them at a secure link, and permanently self-destruct the data exactly 30 days after creation. Judged on clinical-to-vernacular translation, technical architecture and compliance (audio/text recorded, 30-day self-destruct fully functional in database code), and user experience.

## Glossary

- Provider: nurse or clinician using the provider app. Authenticated with the `x-provider-key` header.
- Patient: the person the discharge summary is about. Authenticated only by the unguessable 128-bit link id.
- Caregiver: an optional second recipient who receives the same link only after the patient approves.
- Link: one discharge summary, addressed by `linkId`. The server stores only `sha256(linkId)`.
- Document store: the DynamoDB table (or its SQLite stand-in) holding encrypted raw text, simplified JSON, and translations, each with a TTL attribute.

## User stories and acceptance criteria

### US-1 Provider picks a patient
As a provider, I want to list and search patients so I can attach a discharge summary to the right person.

- GET `/patients` returns the seeded 6 synthetic patients; `?q=` filters by first name, last name, email or phone (case-insensitive substring).
- POST `/patients` creates a patient from `{firstName, lastName, dateOfBirth, zipCode, email, phone}`; invalid bodies return 400 with zod issues.
- Both require `x-provider-key`; a missing or wrong key returns 401.
- Every patient row shows `activeLinkId` (null when none) and `activeLinkExpiresAt`.

### US-2 Provider ingests a discharge summary (text, PDF or audio)
As a provider, I want to paste text, upload a PDF, or dictate audio and get back a patient link immediately.

- POST `/ingest` is multipart: `patientId` (required) plus exactly one of `text`, `file` (PDF) or `audio` (wav/mp3/m4a/webm). Optional `language` (patient preference), `languages` (more languages to translate at synthesis, comma-separated or repeated), `caregiverEmail`, `caregiverApproved` (boolean).
- Empty input (no text, empty PDF, no audio) returns 400 `{ error: "empty_input" }`.
- Success returns 202 `{ jobId, linkId, link: "${PATIENT_APP_URL}/s/${linkId}", patientUrl: "/p/${linkId}", expiresAt, statusUrl: "/jobs/${jobId}", synthesisLanguages }` before any LLM call runs.
- The pipeline runs asynchronously: extract text (pdf-parse, with pdfjs-dist fallback; TranscriberAgent for audio) -> SimplifierAgent -> fidelity check -> encrypt and store raw + simplified -> set `patients.active_link_id` -> email the patient (and caregiver only when `caregiverApproved=true`) -> audit.
- The pipeline is persisted in the SQL `jobs` table so a restart does not lose a job; stages: `received | extracting | transcribing | simplifying | checking | translating | stored | emailing | done | failed | needs_review`. Dictated audio is stored sealed in the audio store before transcription so a restart resumes from it.
- GET `/jobs/:jobId` (provider) returns `{ jobId, stage, error, warnings, createdAt, updatedAt, linkIdHash }`.

### US-3 Patient reads the plain-language summary
As a patient, I want to open my link and see what to do in simple words, with the expiry stated upfront.

- GET `/summary?link=<linkId>` returns the simplified JSON (shape below) plus `{ expiresAt, daysLeft, warnings, checklistState }`.
- 404 for an unknown link, 410 for expired or purged, 425 `{ stage }` while the job is still running.
- Expiry is checked at read time against the app clock, independently of the purge job.
- Every medication name, dose and frequency in the simplified JSON appears verbatim in the source text (deterministic fidelity check). Misses are listed in `warnings[]` and the job is flagged `needs_review` rather than silently shipped.

Simplified summary shape (validated with zod):

```
{ readingLevel: "grade5", language: "en", summary: string (3-5 short sentences),
  diagnoses: [{ plain, clinical }],
  medications: { new: [{ name, dose, howOften, why, startDate? }], continue: [...], stop: [{ name, why }] },
  checklist: [{ id, type: med|appointment|referral|vital|lab|lifestyle, text, due? }],
  returnPrecautions: { call911: [string], goToER: [string], callClinic: [string] },
  followUps: [{ who, when, why }], questionsToAsk: [string] }
```

### US-4 Patient translates on demand
As a patient, I want one tap to see the summary in my language, with my medication names and doses untouched.

- GET `/translate?link=<linkId>&language=<name or ISO code>` returns the translated structured JSON; a language picked at ingest was produced at synthesis and is served from the document store at once (`fromCache: true`); any other supported language runs the TranslatorAgent on the first call and is cached for the second.
- Medication names, doses and frequencies are copied verbatim, never translated. The agent back-translates to English and diff-checks numbers and drug names; mismatches become `warnings[]`.
- GET `/languages` lists supported languages (name, code). Same 404/410/425 rules as `/summary`.

### US-5 Patient checks off the to-do list (advisors' request)
As a patient, I want to tick off medications, appointments and vital checks as I do them.

- POST `/checklist/complete` body `{ link, itemId, completed }` persists the state (keyed by link hash + itemId) and returns the full checklist state. Unknown `itemId` returns 404.
- GET `/summary` includes `checklistState` so the UI can render the ticks.

### US-6 Data self-destructs at exactly 30 days (hard rule)
As a compliance officer, I need every link and its data to be unreadable 30 days after creation, provably.

- `links.expires_at = created_at + 30 days` exactly; every document-store item carries `expiresAt` (epoch seconds) for DynamoDB TTL.
- Every stored payload is encrypted with a per-link AES-256-GCM data key stored in `links.enc_key`. The purge job destroys the key (crypto-shredding), deletes the document-store items, marks the link `purged`, clears `patients.active_link_id`, and writes an audit event.
- The purge job runs every `PURGE_INTERVAL_MS` and on POST `/admin/purge` (DEMO_MODE only). Reads check expiry independently, so a lagging TTL or purge never exposes data.
- POST `/admin/clock/advance { days }` (DEMO_MODE only) shifts the app clock so the judge can watch day 30 arrive.
- Test: advance 30 days -> `/summary` returns 410; purge -> key is null, document items are gone, and the stored ciphertext cannot be decrypted with any remaining material.

### US-7 Provider audits what happened
As a provider, I want to see the event trail for a link without seeing PHI.

- GET `/audit?link=<linkId>` (provider) returns `audit_log` rows `{ event, actor, at, details }` for that link's hash. `details` never contains PHI (no text, no names, no emails).
- Events: `link.created, job.stage, email.sent, email.queued, summary.viewed, translation.created, translation.viewed, checklist.updated, link.expired, link.purged, key.destroyed`.

### US-8 Email delivery with a real cloud path and a demo path
As a provider, I want the patient to receive the link by email, and as a demo runner I want to see that email without an SMTP account.

- `EMAIL_TRANSPORT=console` (default) prints the full message and link to stdout; `smtp` uses `SMTP_URL`; `ses` uses nodemailer's SES transport with `@aws-sdk/client-sesv2`.
- `EMAIL_QUEUE=sqs` enqueues `{ to, subject, text, linkIdHash }` to `SQS_QUEUE_URL` instead of sending; `scripts/email-worker.ts` consumes and sends, and also exports a Lambda `handler`.
- The email body never contains the summary itself, only the link and the expiry date.

### US-9 Document store runs on the team's DynamoDB table or its SQL twin
As the backend owner, I want the real table to be first-class but never required for a demo.

- The table is `discharge-summaries` (hash key `uid`, no sort key, TTL on `expiresAt`), names from the secret's `dynamodb-table` and `dynamodb-table-pk`. One item per link: `uid = link#<sha256(linkId)>`, `expiresAt`, and one attribute per document (`raw`, `simplified`, `translation#<lang>`), each `{ ciphertext, iv, tag, keyVersion, createdAt }`.
- `DOC_STORE=auto` (default) uses DynamoDB when the team secret loaded (credentials present) or `DYNAMO_ENDPOINT` is set, else the SQL twin `discharge_summaries` (same `uid`, one row per document). `local` and `dynamo` force one. `scripts/setup-dynamo.ts` creates the table when missing and enables TTL, idempotently. `docker-compose.yml` and `scripts/dynamodb-local.sh` run DynamoDB Local.
- Verified live against the real table from the build container on 10 Oct 2026: put, get, list, remove one, delete all; a full ingest wrote three documents on one item and was cleaned up.

### US-13 The team diagram's routes and contract (additive)
As Person A and Person C, I want the routes and the JSON the diagram names, without losing anything the note asked for.

- GET `/p/:token?language=` returns the fixed per-language object `{ language, readingLevel, steps, medications, followUps, warnings }` (richer fields optional) plus `meta` beside it: status, expiry, days left, ready and supported languages, safety checks, provenance, checklist state. Same 400/404/410/425 rules as `/summary`; the same loader serves `/summary` and `/translate` in the richer shape.
- POST `/synthesize` (provider): `{ text, languages? }` runs the pipeline as a dry run; `{ linkId, languages?, text? }` re-synthesizes a record in place, deleting translations it did not regenerate with deletion receipts and incrementing `synthesisCount`.
- The contract is published at `/contracts/ai-output.schema.json` and `/contracts/ai-output.ts`; `src/agents/pipeline.ts` exposes the four stages for Person C.
- Spanish, Mandarin and Arabic are the synthesis targets, each with a curated offline fixture for Example 1; twenty languages are accepted on demand.

### US-14 Real team infrastructure
As the team, I want the backend to run on the resources we actually have, with secrets kept out of the repo.

- Config bootstrap from Secrets Manager `hackhealth/secret` at startup when credentials resolve: MySQL host, port, user, password, database and the DynamoDB table and key names; env vars override; only key names are logged; `/health` reports the source.
- SQL on the RDS MariaDB instance `patients` through `mysql2` with TLS from the RDS global bundle (AWS connection step 1, `scripts/fetch-rds-bundle.sh`, committed at `certs/global-bundle.pem`); migrations per dialect; SQLite stays the default for local dev and tests; `SQL_DRIVER=auto` falls back to SQLite when the host is unreachable and says so.
- Audio in the bucket `emraudio-rh` with SSE; its existing 30-day lifecycle rule is verified, not replaced; `AUDIO_STORE=auto` falls back to a local directory when the bucket is unreachable.
- README documents the secret ARN, table and key names, RDS host/port/user, the two AWS connection steps, the IAM permissions, and what was and was not exercised live.

### US-10 Every AI call has an offline twin
As a tester, I want the full suite and the full demo to run with no keys.

- `LLM_PROVIDER=bedrock|anthropic|offline`, `TRANSCRIBE_PROVIDER=aws|offline`. Tests default to offline.
- The offline SimplifierAgent returns curated fixtures for the five example summaries (matched by fingerprint) and a rule-based extraction for anything else. The offline TranslatorAgent uses a small phrase dictionary for Spanish and a marked passthrough for other languages, keeping medications verbatim.
- The default live SimplifierAgent is Amazon Bedrock Converse with tool-based JSON (`BEDROCK_MODEL_ID`, default `us.anthropic.claude-sonnet-4-6`). Example 1 (CHF) is ingested through it at least once and the output stored under `backend/fixtures/live-samples/` with the model id and date.

### US-11 Team integration contract
As a teammate, I want to drop in my own simplifier or translator by replacing one file.

- `backend/src/agents/simplifier.ts` exports `interface SimplifierAgent { simplify(input: { text: string; language?: string }): Promise<SimplifiedSummary> }` and a factory keyed by `LLM_PROVIDER`.
- `backend/src/agents/translator.ts` exports `interface TranslatorAgent { translate(input: { summary: SimplifiedSummary; language: string }): Promise<TranslatedSummary> }`.
- README documents: implement the interface, export it from `src/agents/custom/<name>.ts`, register it in the factory, set the env var.

### US-12 Docs and demo
- OpenAPI 3 spec at `backend/openapi.yaml`, served at `/docs` (swagger-ui-express) and `/openapi.json`.
- `backend/README.md`: precedence, run in one command, lane-by-lane diagram mapping, team infrastructure, env table, endpoint table with curl, agent contract, demo narrative, "needs a key / not exercised live" table, "what stays under human control", what the other branch has.
- `scripts/demo.sh` runs the narrative against a running server with offline providers: ingest Example 1 with es,zh,ar picked -> email printed -> GET /summary -> GET /p/:token -> the picked languages from the store and Portuguese on demand -> checklist tick -> POST /synthesize dry run -> advance clock 30 days -> 410 -> purge -> deletion receipts.

## Non-functional requirements

- No PHI in logs: pino with redaction of bodies, emails, text fields and the provider key; request logs carry only method, path, status, latency and link hash prefix.
- Node 24 (`engines >=24`, `.nvmrc`), TypeScript (ESM, NodeNext), Express 5, zod 4, better-sqlite3 by default (prebuilt binary for Node 24), MariaDB/MySQL via `mysql2` (the team's production database).
- Tests: vitest, offline providers, 88 tests in 19 files on 10 Oct 2026, counts recorded in README.
- Product law: the backend never emits text a user sends as their own. It explains and translates the clinician's instructions and speaks as itself.
- Copy: confident present tense, no product-history narration, no em dashes.
