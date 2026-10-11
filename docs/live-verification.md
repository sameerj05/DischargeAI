# Live verification - 2026-10-11

**Current state:** The original frontend design is connected to all four requested features. Persistent local SQLite stores patient registration, plans, translations and app files; the authorized hackathon AgentCore runtime generates plans, HealthScribe recognizes English microphone audio in us-east-1, the existing AI-Infra agent translates into Spanish/Chinese/Arabic, and ElevenLabs supplies multilingual MP3 read-aloud. The current build and 38 unit/API tests pass; all 16 Swagger operations have HTTP coverage. The original browser regression also passes. The full live browser check passed in 246 seconds. Its authoritative result is the ignored .tools/features-live-report.json. Spanish, Chinese and Arabic translations all returned verified status, preserved checklist IDs and played generated audio. A real server restart retained the plan and all translated caches with the original expiry unchanged. Team-account database/storage remain unverified.


## Current feature verification

Audio follow-up: after a report of no sound, a fresh live ElevenLabs request returned a non-silent MP3 and Edge playback advanced past 10 seconds, with browser volume 1 and mute false. Windows' default speakers were present, at 100% and unmuted. This did not reproduce the user's missing sound or establish what the user heard. The original speaker buttons now expose a preparing message and native audio controls during playback, including a direct Play action when browser policy blocks playback. Both browser tests pass, including simulated browser-policy rejection followed by actual MP3 playback through native controls, cancellation during preparation, and stop. The build and 38 unit/API tests also pass. Diagnostic evidence is in ignored `.tools/audio-diagnostic.json`.

| Check | Result |
| --- | --- |
| Backend typecheck and frontend production build | Pass |
| Unit/API tests | 38 passing; all 16 Swagger operations covered |
| Original frontend regression | Pass: text/PDF/audio, both roles, append, errors, expiry and purge |
| Full live feature browser test | Pass: create/match patient, 35-second microphone recording, HealthScribe, AgentCore, unchanged link/expiry, four languages and ElevenLabs playback, checklist continuity, caregiver and Swagger |
| Translation agent | Spanish, Chinese and Arabic verified; existing AI-Infra translator/verification code used |
| Real application restart | Plan and translated caches persisted; original expiry unchanged |
| Browser secrets | Supplied provider credentials absent from compiled frontend bundles |

Current synthetic plan: http://127.0.0.1:4000/s/xz_JQYp3QdTCGjpXWjubqINBjhdJOsCSI-V0DV5qwUE (DOB `2000-01-01`). The app is running at http://127.0.0.1:4000. Use `npm run local:ai` to restart it. Test commands and manual steps are in [README](../README.md). The frontend stylesheet was not changed for these features.

HealthScribe uses the dedicated private, encrypted staging bucket and service role described in [its setup guide](../backend/docs/healthscribe-setup.md). The actual staging cleanup audit is `.tools/healthscribe-aws-report.json`; application data stays in ignored `.local-data`. Emails are captured locally. Synthetic integration tests do not establish clinical accuracy or team-account database access.

## Earlier AgentCore-only verification

AWS browser sign-in established profile `dischargeai-live` for account **958824257887**, role `WSParticipantRole/Participant`. The existing READY runtime is `arn:aws:bedrock-agentcore:us-west-2:958824257887:runtime/dischargeai-RmaTcNGSRO`. No AWS infrastructure was deployed or modified, and the configured team defaults in account 183815333909 were retained.

The backend's actual SDK provider invoked this runtime directly with synthetic notes, then through the complete browser → HTTP → job → AgentCore → stored response → patient/caregiver workflow. The first browser run passed for synthetic text (97 seconds) and synthetic PDF (47 seconds). Its output contained the submitted furosemide instructions, with no local AI fixture content. The runtime returns `{result, status, flags}`, with Markdown in `result`. The frontend now adapts recognized AI-Infra Markdown headings into the original cards/checklists; unknown formats preserve the complete text fallback. CSS and shared UI controls match the original branch.

The strict build and **29 unit/API tests** pass. They cover all 14 Swagger operations, explicit live-runtime configuration, SDK serialization through the local pipeline, persisted AWS failures with no fixture fallback, and Markdown medication/follow-up preservation. The original frontend's offline browser regression also passed after these changes.

Real transcription is unavailable in this mode, so audio returns 501 and the microphone is disabled. Translation remains unimplemented (501). Email is captured locally. SQL, summaries and uploaded files are local and clear on restart. These tests establish live AI invocation and application integration; they do not establish clinical correctness, human clinical review, delivered email, or use of the team's RDS/S3/DynamoDB resources.

The user explicitly authorized sending extracted **Example 1** of the practice PDF to this runtime/account/region. Its 4,803 characters completed the live browser workflow in **254.5 seconds** and returned 4,159 generated characters. The synthetic PDF rerun completed in **47.9 seconds**. Both rendered structured cards through the Markdown adapter in patient and caregiver views with no browser errors or external frontend API requests.

A separate browser check of the already-generated Example 1 plan verified every medication name/detail, new/stopped/held medicine, lab, appointment, care instruction, warning, hospital explanation and general instruction in both roles. It checked 11 medication dose rows, four new medicines, three stopped/held/avoided medicines, one lab, two appointments and seven warnings, plus checklist persistence after reload. This compares UI rendering to the generated response; it is not a clinical quality assessment of that response against the source.

Other examples and the full supplied PDF were excluded from live invocations. Evidence is in ignored `.tools/live-workflow-report.json`, `.tools/live-render-report.json`, `.tools/live-*-summary.json` and `.tools/live-*.png`. That earlier in-memory server has been restarted; the following historical Example 1 link is no longer available: `http://127.0.0.1:4000/s/5fSHlKRa2haO6dZ_H9LxIfOhnHEdQ9OVt6aR22dMUyc` (test DOB `2000-01-01`).

The prior AWS checks below describe access to the team resources, separately from this working mode.

## Earlier fixture-only verification

The strict build and 29 API/unit tests pass. All 14 Swagger operations have HTTP coverage. The browser workflow passes through real local requests for server login, separate patient drafts, text/PDF/audio submissions, patient and caregiver plans, checklist persistence, review flags, translation errors, job failures, Swagger, and expiry/purge. Styles and shared UI controls are unchanged from the original branch.

The supplied 14-page practice PDF yielded 21,603 characters and five numbered examples. Its PDF ingestion plus five separate text cases passed, with 12 emails captured locally. The browser also uploaded this actual PDF successfully. AI output and speech recognition remain fixtures; no clinical accuracy or live AWS delivery is established. Commands and manual steps are in [the root README](../README.md).

## Historical local application verification before frontend restoration

Before design restoration, `npm run local` started a different frontend with the real API on loopback without AWS credentials or resource ARNs. It used the production SQL repositories over in-memory SQLite, memory stores and labeled agent/transcription fixtures, and captured outbound email locally. The current runner retains these isolated backend components with the original frontend design. `npm run dev` and `npm start` continue to use the AWS context.

`npm run test:browser` exercises the actual browser → HTTP API → SQL/job pipeline → stored summary → patient/caregiver view, without intercepting API responses. Checked workflows include provider-key rejection/acceptance, submitted text appearing in the patient plan, readable PDF extraction and storage, actual browser recording/multipart upload with fixture transcription, asynchronous job completion, checklist persistence, local email capture, failed jobs producing no email, all 12 Swagger operations rendering, HTTP 410 after advancing the test clock, and deletion of four summary items plus one PDF and one audio clip with six receipts. This verifies local application behavior; it does not verify AWS permissions, RDS compatibility, live model quality, actual speech recognition, or outbound email delivery.

See [current preview instructions](../README.md).

Temporary hackathon credentials were used only in the verification processes. STS identified account `958824257887`, assumed role `WSParticipantRole/Participant`, in region `us-west-2`. The application's configured resources belong to account `183815333909`.

| Check | Result | Evidence / limit |
| --- | --- | --- |
| Backend typecheck and frontend production build | Pass | `npm run build` |
| HTTP integration and SDK tests | Pass | Four tests; AWS and SQL use isolated test doubles. Covers text/PDF/audio ingestion, polling, summary rendering, expiry, Swagger routes, and frontend serving. |
| Browser checks | Pass | Headless Edge with intercepted API responses; provider login, text/PDF upload, patient/caregiver views, pending and expired links, and both roles displaying the live runtime's `result` response format. These are local UI checks. |
| AWS credentials | Pass | `aws sts get-caller-identity` reports the hackathon account and participant role. |
| Hackathon AgentCore runtime | Pass | Runtime `dischargeai-RmaTcNGSRO`; two successful calls through the backend's actual `DischargeAgent` adapter with synthetic notes, approximately 31 and 43 seconds. |
| Hackathon agent response contract | Differs from source contract | Returns `result`, `status`, `flags`; no `summary` or structured `plan`. The second call returned 692 result characters, `approved` status, and the input medicine name. The frontend now displays `result` as a text summary. |
| Team AgentCore runtime | Denied | Invocation of `DischargeAIAgent_DischargeAI-y8mQ6FEN5u` returned HTTP 403 / `AccessDeniedException`. |
| Team DynamoDB table | Denied | Both `DescribeTable` and `GetItem` addressed the **full ARN** `arn:aws:dynamodb:us-west-2:183815333909:table/discharge-summaries`. AWS reported no resource-based policy allowing these actions for the hackathon role. `GetItem` used a synthetic nonexistent key, with only `uid` projected. |
| Team database secret | Denied | `GetSecretValue` for `hackhealth/secret-ZWa02Q` returned `AccessDeniedException`; no secret value was printed. |
| Team PDF/audio buckets | Denied | `HeadBucket` on `emrpdf-rh` and `emraudio-rh`, with the team expected owner, returned 403. |
| RDS network connection | TCP reachable | `patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306` accepted a TCP connection. Database authentication and queries remain unverified. |
| Backend boot with supplied credentials | Blocked | Secret bootstrap could not supply SQL credentials; startup reported that no SQL database is configured. |
| Complete live frontend → API → SQL/S3/AgentCore/DynamoDB → patient link | Not verified | Requires access to the team resources or an explicitly configured replacement environment. Live PDF extraction/storage, Transcribe Medical, email delivery, and expiry cleanup were not run. |

The hackathon account's regional inventory showed no RDS instances or DynamoDB tables, and only the AgentCore CodeBuild source bucket in S3. This is inventory for that account and region, not evidence that the team resources are missing.

During the historical checks below, no infrastructure was deployed or modified. The later HealthScribe integration created dedicated staging resources. No outbound emails were sent. No code was committed or pushed.

## Reproduce the agent check

With authorized credentials supplied through the normal AWS credential chain:

```powershell
$env:AWS_REGION = 'us-west-2'
# Optional: override only for a runtime you have permission to invoke.
$env:AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-west-2:958824257887:runtime/dischargeai-RmaTcNGSRO'
npm --prefix backend run verify:agent
```

The script sends synthetic notes, uses the backend SDK adapter and a verification-only contract mapper under `backend/scripts/verification/`, and reports invocation and response compatibility. That mapper is independent of the restored frontend. It makes no SQL, DynamoDB, S3, or email writes. A nonzero exit code also signals a mismatch with the canonical `{status, flags, summary, plan}` response contract, even if invocation succeeds and summary text is present.

## Access needed next

An ARN identifies the table; it does not grant access. DynamoDB supports the full table ARN in `TableName`. For direct cross-account access, the caller's identity policy and the table's resource policy must both allow the requested operations. See [AWS's DynamoDB cross-account access documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/rbac-cross-account-access.html).

Provide the exact table ARN if it differs from the one tested. Continuing against the existing team environment also requires team-account credentials or an assumable team role with access to its secret, AgentCore runtime, DynamoDB table, and S3 buckets. SQL credentials and a successful database login are still required. The backend already forwards `DYNAMO_TABLE` unchanged to SDK `TableName`, so it can accept a full table ARN when access is granted.
