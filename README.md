# DischargeAI

The workspace combines the frontend from `origin/frontend+backend`, the TypeScript backend from `main`, and agent source from `origin/AI-Infra`. The original frontend layout, styles, branding, and role controls are preserved. Its data and submit actions now use the backend's `/api` routes. No code has been committed or pushed.

## Run and test locally

Use Node 24 or newer:

```powershell
npm run install:all
npm run build
npm test
npm run test:browser
npm run local
```

Open **http://127.0.0.1:4000**. Sign in as doctor with **`rivera@demo.health` / `demo1234`**. The server validates this demo account only in local test mode. The dashboard loads synthetic patients from the actual backend SQL repositories.

1. Select **Alex Example** and paste one practice case into **Visit writeup**, or use the existing PDF attachment button. Upload into an empty note to send the original PDF bytes; editing or combining its extracted text submits text instead.
2. Click **Send writeup** and wait for **Plan ready**. This sends the real HTTP request and follows the asynchronous job.
3. Open **Open patient plan**. Choose the **Patient** or **Caregiver** tab and enter **`2000-01-01`** as the test patient's DOB. The backend checks the token and DOB against the patient repository. Both roles show the summary belonging to that submission.
4. Try the checklist, refresh, and check that progress persists for that specific plan. It remains browser session state; there is no checklist API.
5. Test dictation using the microphone control: a labeled synthetic transcript appears while recording and is finalized when you stop. Review/edit the text, then send. Fixture mode recognizes no actual speech and needs no AWS credentials.
6. Submit `[LOCAL_TEST_FAIL]` to exercise an agent failure. The UI displays the failure and the backend captures no email for that failed job.

The demo patient/caregiver codes displayed on the login screen resolve to Alex's latest submitted plan. Submit a writeup first. Use the actual generated link to open a specific plan. Restarting the local runner clears all test data.

Local mode uses SQLite in memory, production repositories/routes/job processing, memory document/object stores, **labeled AI and transcription fixtures**, and a captured email outbox. It ignores AWS credentials and `.env` settings. ElevenLabs playback is unavailable in fixture mode. Medication examples in the fixture are fixed interface test content, not medications extracted from your notes. Local tests verify application wiring and storage; they do not verify AI clinical correctness, real speech recognition, RDS behavior, or delivered emails. Translation currently returns **501** and the UI displays that limitation instead of demo translations.

## Generate a real plan with local storage

`npm run local:ai` loads the ignored `backend/.env` and connects the original frontend to live AgentCore, Transcribe Medical streaming dictation, the existing AI-Infra patient translation agent, and ElevenLabs. Patient records, notes, plans, translated caches, and app file bytes persist locally in `.local-data/dischargeai.sqlite`. The app does not use the team's DynamoDB table or database secret. The microphone streams audio through the backend and requires no S3 bucket; AWS credentials stay server-side. Emails remain captured locally.

AWS access uses the machine's default credentials (local profile, or the instance role on the server); no AWS keys are stored in `backend/.env` or sent to the frontend. The ElevenLabs key, when used, lives only in ignored `backend/.env` and needs text-to-speech permission; listing voices is optional.

```powershell
npm run build
npm run local:ai
```

Open **http://127.0.0.1:4000**; doctor login is **rivera@demo.health / demo1234**. Stop the previous server first if port 4000 is busy. To set up this environment elsewhere, copy `backend/.env.example`, configure the runtime/bucket/role, set `SPEECH_PROVIDER=healthscribe`, `TRANSLATION_PROVIDER=ai-infra`, and the ElevenLabs key. Install `AI-Infra/requirements.txt` in a Python environment and point `PYTHON_EXECUTABLE` to its interpreter. Standard AWS profiles/instance roles also work; shell values take precedence over the file.

1. Click **Register patient**, enter a patient ID and real DOB, optionally name/contact details, and save. An existing ID with the same DOB is matched; a different DOB is rejected.
2. Paste text, attach a readable PDF, or click the microphone and speak English. Transcribe Medical updates the writeup as you speak, appending to any existing draft. Stop dictation to collect the final words, review/edit the text, then click **Send writeup** to generate the plan. Sending is disabled while dictation starts, records or finishes. Changing patients or signing out releases the microphone. Plan generation can take several minutes.
3. A second submission for the same ID/DOB appends notes to the active plan and regenerates it. Its link and original expiry remain unchanged. Once that 30-day period expires, a new submission creates a fresh plan/link. Translated caches are invalidated on updates. The older API without DOB still creates independent plans.
4. Open the patient link and confirm that patient's DOB. Choose English, Spanish, Chinese or Arabic from the existing language picker. The AI-Infra agent translates and verifies the plan; checklist IDs remain stable across languages. Review flags are displayed when verification reports a problem.
5. Use a section's speaker button to hear ElevenLabs audio in the selected language. A preparing message appears while it loads, followed by standard audio controls for play/pause, volume and seeking. If the browser blocks automatic playback, press Play on that player; it uses the already generated audio. Click the speaker again to stop. Changing language stops playback. The server only accepts text from that displayed plan, checks expiry, and keeps the provider key private.

Local data survives restarts in this mode. Read access expires exactly 30 days after the original plan was created; a local sweep deletes expired plan documents and file bytes at startup and every minute. Patient registration rows remain available for later visits. The automated agent verdict is not a human clinical review.

Live dictation defaults to `TRANSCRIBE_STREAMING_REGION=us-west-2` and requires `transcribe:StartMedicalStreamTranscription` permission. Provider failures appear in the editor and retain your displayed draft. Streaming transcripts can revise words until finalized; review the final text before sending.

For an opt-in speech-only browser check, run `npm run test:dictation:live`. It loads `backend/.env`, starts an isolated local app, and uses the synthetic WAV at `.tools/healthscribe-test.wav` (or `LIVE_TEST_AUDIO`) as a fake microphone. It verifies actual AWS partial results updating the textarea during recording, final transcription and editing after stop. The ignored evidence is `.tools/dictation-live-report.json` and `.tools/dictation-live-recording.png`. Only real speech calls are made; plan generation uses fixtures.

For an opt-in **full feature browser check** with synthetic data, keep `local:ai` running, set `LIVE_TEST_AUDIO` to a synthetic mono PCM WAV conversation, then run `npm run test:features`. It exercises real streaming microphone transcription, AgentCore, patient matching and append, all four language displays, actual ElevenLabs audio decoding/playback, checklist continuity, caregiver access and Swagger. The default test WAV is ignored `.tools/healthscribe-test.wav`; the report and screenshots are `.tools/features-live-report.json` and `.tools/features-*-patient.png`. These opt-in commands make paid provider calls and are excluded from ordinary unit tests.

To run an opt-in live browser check with synthetic text and a synthetic PDF:

```powershell
# The running local:ai app uses backend/.env.
$env:LIVE_TEST_ORIGIN = 'http://127.0.0.1:4000'
npm run test:live
```

Without `LIVE_TEST_ORIGIN`, the test starts and closes an isolated local server. It invokes AWS and checks doctor submission, completion, saved response and patient/caregiver rendering through real HTTP. The ignored report is `.tools/live-workflow-report.json`; summaries and screenshots are `.tools/live-*.json` and `.tools/live-*.png`. These verify integration, not clinical correctness.

The live test accepts `PRACTICE_PDF` only for extracting **Example 1** as a text request; its PDF request remains synthetic. Sending clinical examples to AWS requires authorization for that data and runtime. The user explicitly authorized Example 1 to the account and region above, and the live test passed in about 4 minutes 15 seconds. Both patient and caregiver views displayed the generated medications, changes, follow-up and warnings. Other examples have not been sent to AWS. Details are in [the verification report](docs/live-verification.md).

## Use the practice PDF

```powershell
npm run test:practice -- "C:\Users\jelan\Downloads\20261010_091950 (1).pdf"
```

This extracts the document locally, sends each numbered example as a separate text request, verifies the full-document PDF parsing/storage path, and runs the browser workflow with that PDF. It sends no data to AWS. The report goes to ignored `.tools/practice-report.json`; browser screenshots go to `.tools/connected-*.png`.

The supplied PDF contains 14 pages and five examples. Treat each example as a separate case when evaluating a real agent; uploading the whole collection for one real patient would mix cases. The full-document test here checks only plumbing with fixtures.

## Check every API in Swagger

Open **http://127.0.0.1:4000/api/docs/** and authorize with **`local-test-key`**. There are 16 documented operations, including the two login-form adapters. Start with **GET /patients**, then:

```json
{ "patientID": "7", "DOB": "2000-01-01", "type": "text", "data": "Synthetic practice notes" }
```

**POST /ingest** returns 202 and a `jobId`, `sumId`, and patient link. Follow **GET /jobs/{jobId}** until `done` or `failed`, then read **GET /p/{token}** with the returned `sumId`. Reading while processing returns 425. The summary endpoint aliases return the same stored response. **POST /synthesize** can run standalone text or regenerate a saved summary. Both translation endpoints use the configured AI-Infra translator; fixture mode returns 501.

`npm test` includes unit tests and HTTP tests for every documented operation. It checks authentication, malformed bodies, unknown IDs, upload limits, PDF and audio inputs, async failures, summary aliases, reruns, expiry, purge, audit receipts, agent SDK serialization, and the actual frontend response adapter. The suite fails if a new documented operation has no API test.

`npm run test:browser` drives Edge/Chromium through the real local HTTP server without intercepting API responses. It checks the original layout, server login, patient selection and separate drafts, text/PDF/audio submissions, patient/caregiver views, checklist persistence, review flags, translation errors, failures, Swagger, and expiration cleanup. On Windows it uses installed Edge; otherwise install Chromium with `npx --prefix backend playwright install chromium`.

## Full verification against AWS

The local-storage live mode above works independently of the team resources. The prior live checks established that the hackathon credentials access account **958824257887**, while the configured team resources belong to **183815333909** and deny those credentials. Verification of the team database/storage remains blocked by that access. See [the live verification report](docs/live-verification.md) and [backend configuration](backend/README.md).

The backend invokes AgentCore with `{ "notes": "..." }`, matching the AI-Infra entrypoint. The frontend renders structured `plan` responses and recognizes the hackathon runtime's Markdown `result` format for the existing cards. Editing the local AI source does not change a deployed runtime. The local-storage/live-AI mode above has now been verified separately from the full team AWS environment.

For a live test, configure team AWS/SQL access, the runtime, document table, PDF/audio buckets, mail transport, and `PATIENT_APP_URL` for the running application. `npm run dev` starts the AWS backend plus Vite (which proxies `/api` to port 4000); `npm start` serves the built app with the AWS backend. The original UI's email/password provider login is **local only**: the AWS server returns 501 until a production identity provider is implemented. Authorized live API checks can use the provider key in Swagger. Patient/caregiver roles currently select presentation for the same bearer link; existing GET summary APIs still authenticate by possession of that link.

A real AWS acceptance run must separately verify database reads, PDF/audio object writes, live extraction/transcription, AgentCore output for each case, DynamoDB retrieval, patient/caregiver rendering, actual email delivery, and expiry cleanup in an isolated test environment. Compare generated output with each source example for retained medication dose/frequency, stopped/changed medications, follow-up, warnings, and review flags. The local fixture tests do not establish any of those live AI or cloud results.
