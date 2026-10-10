# DischargeAI backend: research notes

Date: 2026-10-10. Container: Node 22.22.0, npm 10.9.4, Java 21.0.12, Linux. Every URL below is marked `fetched` (we read the page or file), `search-result` (seen only in a search listing) or `verified-locally` (we ran the code). Nothing here was invented.

## 1. What the product must do (sources we read)

- Challenge brief, Ops Unleashed Challenge 1 "Discharge AI" (hackathon handout, local file): audio or EMR text in, 5th-grade plain language plus native-language translation out, secure patient link that fully wipes the database entry exactly 30 days after creation. Judged on translation quality, architecture and compliance (30-day self-destruct in database code), and UX.
- Advik's API design note (Granola): SQL patient table, GET /patients, POST /ingest returns 202 then async PDF->text->LLM->DynamoDB->email, GET /summary, GET /translate with caching; ownership split (backend owns SQL, endpoints, DynamoDB logic; teammates own the two LLM agents).
- Clinical advisors' note (Granola): checklist with check-offs, caregiver link with patient consent, 30-day expiry stated upfront, CHF as the demo population, Transcribe Medical / HealthScribe for voice, Comprehend Medical as a pre-LLM layer, Bedrock guardrails for PII, Epic/FHIR framed as future.
- Five synthetic discharge summaries (hackathon handout `DC Summary Instructions.pdf`, 14 pages): Example 1 (HFrEF + pneumonia + AKI) is the default demo. Medication lists are grouped as New / Continue / Stopped-held with explicit doses, which the fidelity check relies on.
- Teammates' `frontend` branch (`frontend/src/App.tsx`, React 19 + Vite 6 + Tailwind 4): a provider composer with Write / Dictate / PDF modes and no API calls yet. `PATIENT_APP_URL` defaults to `http://localhost:5173` (Vite default). The backend contract in spec.md is the contract to publish to them.

## 2. Open-source building blocks

| Topic | URL | Gives us | License | Status |
|---|---|---|---|---|
| Hallucination guardrail pattern (validate LLM output against source text) | https://github.com/dhruv4115/medical-report-simplifier | Node/Express service with a `validation.service.js` that rejects tests not present in the source; same idea as our fidelity check | none stated | fetched (README) |
| Discharge instruction simplifier with daily checklist | https://github.com/geraldineamalor/healthcare-discharge-agent | Rule-based (no LLM) detection of medications, frequencies, durations and follow-ups; good reference for the offline provider's rule-based fallback and the checklist shape | none stated | fetched (README) |
| Patient-facing discharge summary + translation (HackMIT 2022 winner) | https://github.com/uyxela/hackmit2022 | Express + FastAPI app doing summary and translation of discharge notes; confirms the summarize-then-translate split | MIT | fetched (README) |
| Prescription sig parsing (NER + rules) | https://github.com/royashcenazi/parsigs | Python; defines the structured fields (drug, strength, frequency, interval, period) we mirror in `medications[]` | MIT | fetched (README) |
| Dose string parser, TypeScript | https://github.com/jckw/dosis | Unit table (mg, g, mcg/ug, plurals, case) and normalization approach reused in `verify/fidelity.ts` | MIT | fetched (README); npm 0.1.0 install is broken (`dist/parser` missing), so not a dependency |
| Readability scoring | https://www.npmjs.com/package/text-readability | `fleschKincaidGrade`, `fleschReadingEase`; ran locally: grade 1.6 on a sample summary | ISC | verified-locally |
| Discharge-readiness decision support (FHIR, citations per claim) | https://github.com/arshgill01/Discharge-Gatekeeper | "Every finding cites a source" pattern; LLM bounded to reading notes, deterministic layer decides | none stated | search-result |
| Patient advocacy app with a discharge translator | https://github.com/simongonzalezdc/healthadvocate | FastAPI; every endpoint returns `{explanation, urgency, action_items, red_flags, validation}`; validation block mirrors our `warnings[]` | MIT | search-result |
| Self-destructing links, crypto-shredding reference | https://github.com/onetimesecret/onetimesecret | Per-secret key handling and expiry semantics | MIT | search-result |
| Self-destructing encrypted links | https://github.com/jhaals/yopass | Key in URL fragment, server stores only ciphertext with expiration | Apache-2.0 | search-result |
| LLM patient-oriented discharge summaries, RCT | https://www.thelancet.com/journals/landig/article/PIIS2589-7500(26)00014-2/fulltext | Evidence that LLM plain-language summaries raise patient activation; prompt instructed "rephrase without generating new clinical information" (we copy that rule) | n/a | search-result |
| Discharge summary generation with LLMs, systematic review (Clinical NLP @ LREC 2026) | http://www.lrec-conf.org/proceedings/lrec2026/workshops/clinicalnlp/pdf/2026.clinicalnlp-1.9.pdf | Hallucination and privacy as the top risks; supports the deterministic post-check | n/a | search-result |
| Provider-agnostic LLM runtime for Node | https://github.com/node-llm/node-llm | Considered for the provider switch; rejected (we need only Bedrock, Anthropic, offline and want zero abstraction over Converse) | MIT | search-result |

Library docs fetched from GitHub raw (kept under the scratchpad, not committed):

- nodemailer README https://raw.githubusercontent.com/nodemailer/nodemailer/master/README.md (fetched)
- pdf-parse README and options https://raw.githubusercontent.com/mehmet-kozan/pdf-parse/main/README.md , https://raw.githubusercontent.com/mehmet-kozan/pdf-parse/main/docs/options.md (fetched)
- better-sqlite3 API https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/api.md (fetched)
- @aws-sdk/client-bedrock-runtime README https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/clients/client-bedrock-runtime/README.md (fetched)
- @aws-sdk/lib-dynamodb README (npm package README, fetched)
- AWS docs via Anakin scrape: DynamoDB TTL https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html (fetched), DynamoDB Local https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html (fetched), Transcribe StartMedicalTranscriptionJob https://docs.aws.amazon.com/transcribe/latest/APIReference/API_StartMedicalTranscriptionJob.html (fetched), nodemailer SES transport https://nodemailer.com/transports/ses (fetched)
- AWS SDK v3 Bedrock ConverseCommand reference https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/ConverseCommand (search-result; the exact TypeScript shapes below come from the installed package's `dist-types`, which is authoritative for 3.1149.0)
- Bedrock ToolChoice / SpecificToolChoice https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_SpecificToolChoice.html (search-result: "The Model must request the specified tool. Only supported by Anthropic Claude 3 and Amazon Nova models." Our live run shows it also works on the Claude 4.x profiles in this account.)

## 3. Install verification (throwaway `npm install` in the scratchpad)

All of these installed and loaded on Node 22.22.0 (exit 0, versions as installed):

Runtime: `@aws-sdk/client-bedrock-runtime@3.1149.0`, `@aws-sdk/client-dynamodb@3.1149.0`, `@aws-sdk/lib-dynamodb@3.1149.0`, `@aws-sdk/client-secrets-manager@3.1149.0`, `@aws-sdk/client-sesv2@3.1149.0`, `@aws-sdk/client-ses@3.1149.0` (not needed; nodemailer wants sesv2), `@aws-sdk/client-sqs@3.1149.0`, `@aws-sdk/client-transcribe@3.1149.0`, `@aws-sdk/client-s3@3.1149.0`, `better-sqlite3@13.0.3` (native module built and ran an in-memory query; bundles SQLite 3.53.4, which has `CONCAT`), `mysql2@3.24.5`, `express@5.3.0`, `multer@2.4.0`, `nodemailer@10.1.0`, `p-queue@9.3.3` (ESM only), `pdf-parse@2.4.5` (Apache-2.0, pulls `pdfjs-dist@5.4.296` and `@napi-rs/canvas`), `pdfjs-dist@6.4.299`, `pino@10.4.0`, `pino-http@11.0.0`, `swagger-ui-express@5.0.1`, `yaml@2.9.1`, `zod@4.6.5`, `text-readability@1.1.1`. `pg@8.23.1` installed fine but was removed on `alt-backend` (Postgres is not the team's database).

Dev: `typescript@7.0.2` (tsc with `module: NodeNext` passes), `tsx@4.23.15`, `vitest@5.0.3`, `supertest@7.3.1`, `node-sql-parser@5.4.0` (parses the MariaDB migration in the tests; its grammar treats `status` as a keyword, so the test renames that column for the parse only), `@types/express@5.0.6`, `@types/node@26.6.5`, `@types/better-sqlite3@9.6.0`, `@types/multer@2.3.0`, `@types/supertest@7.2.1`, `@types/swagger-ui-express@4.1.8`, `drizzle-orm@0.45.4` (installed fine; not used, see design.md).

Licenses: express MIT, zod MIT, pino MIT, better-sqlite3 MIT, nodemailer MIT-0, pdf-parse Apache-2.0, pdfjs-dist Apache-2.0, p-queue MIT, swagger-ui-express MIT, multer MIT, pg MIT, yaml ISC, text-readability ISC, AWS SDK Apache-2.0, vitest MIT, tsx MIT.

Failures and alternatives:

- `dosis@0.1.0` installs but `import('dosis')` fails (`Cannot find module .../dist/parser`). Alternative: own regex normalizer in `verify/fidelity.ts`.
- `@types/nodemailer` conflicts with nodemailer 10's bundled types (per its README). Alternative: do not install it.
- Docker daemon is not running in this container (`docker pull` fails on the socket), so `docker compose up` for DynamoDB Local cannot be exercised here. Alternative verified: the DynamoDB Local jar downloads from `https://s3.us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.tar.gz` (HTTP 200; the CloudFront mirror is blocked with 403) and runs on Java 21 with `java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000` (reports version 1.25.1). Ship `scripts/dynamodb-local.sh` next to `docker-compose.yml`.
- pdf-parse v2 API differs from the v1 snippet that most tutorials show: `const { PDFParse } = require('pdf-parse'); const p = new PDFParse({ data: buffer }); const r = await p.getText(); r.text; r.total; await p.destroy();`. Verified on the 14-page hackathon PDF (21,820 chars). Fallback verified: `const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false }).promise; page.getTextContent().items.map(i => i.str).join(' ')`.

Integration smoke (vitest 5, 4/4 passed; tsc clean; tsx runs): Express 5 route with `multer.memoryStorage()` + zod body validation + p-queue + better-sqlite3 + AES-256-GCM round trip; async route throwing reaches the error middleware (Express 5 behaviour, no wrapper needed); empty input rejected.

## 4. Exact API shapes the builder codes against

### 4.1 Amazon Bedrock Converse (`@aws-sdk/client-bedrock-runtime` 3.1149.0)

Request (`ConverseCommandInput`, from the installed `dist-types/models/models_0.d.ts`):

```ts
{
  modelId: string;                       // inference profile id, e.g. "us.anthropic.claude-sonnet-4-6"
  system?: [{ text: string }];           // SystemContentBlock[]
  messages: [{ role: "user" | "assistant", content: [{ text: string }] }];
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number; stopSequences?: string[] };
  toolConfig?: {
    tools: [{ toolSpec: { name: string; description?: string; inputSchema: { json: object }; strict?: boolean } }];
    toolChoice?: { auto: {} } | { any: {} } | { tool: { name: string } };
  };
  additionalModelRequestFields?: object;
  requestMetadata?: Record<string, string>;
}
```

Response (`ConverseCommandOutput`):

```ts
{
  output: { message: { role: "assistant", content: ContentBlock[] } };
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "guardrail_intervened" | "content_filtered";
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
  metrics: { latencyMs: number };
  $metadata: { httpStatusCode: number; requestId: string; ... };
}
// ContentBlock union members we use: { text: string } | { toolUse: { toolUseId: string; name: string; input: object; type?: "tool_use" } }
```

Live run 1, `verified-locally` on 2026-10-10T18:48:10Z, region us-west-2, model `us.anthropic.claude-sonnet-4-6`, forced `toolChoice: { tool: { name: "emit_summary" } }`, `temperature: 0`, `maxTokens: 1024`. HTTP 200, 2,812 ms wall, `metrics.latencyMs` 2483, `stopReason: "tool_use"`, `usage: { inputTokens: 958, outputTokens: 230, totalTokens: 1188 }`. `output.message.content` had exactly one block:

```json
{ "toolUse": { "toolUseId": "tooluse_CvIGQfhiGPmFpYQ0vnGwzy", "name": "emit_summary", "type": "tool_use",
  "input": { "summary": "You are going home with two new medicines to help your heart and blood pressure. One old medicine was stopped because a new one is doing the same job. Make sure to take your new medicines every day and call your doctor if you feel dizzy or swollen.",
    "medications": { "new": [ { "name": "Furosemide", "dose": "40 mg", "howOften": "once daily by mouth", "why": "To help remove extra fluid from your body (volume management)" },
                              { "name": "Losartan", "dose": "25 mg", "howOften": "once daily by mouth", "why": "To help your heart work better and keep your blood pressure under control" } ],
                      "stop": [ { "name": "Lisinopril", "why": "Stopped because Losartan is now doing the same job" } ] } } } }
```

Live run 2, `verified-locally` on 2026-10-10T18:52:29Z, model `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `toolChoice: { auto: {} }` plus the system line "Always answer by calling the tool emit_summary exactly once". HTTP 200, `metrics.latencyMs` 1449, `stopReason: "tool_use"`, `usage: { inputTokens: 697, outputTokens: 159, totalTokens: 856 }`, content was again a single `toolUse` block (no leading text block) with `input.medications.new[0] = { name: "Furosemide", dose: "40 mg", howOften: "once daily by mouth" }`.

What the builder does with this: `const block = res.output.message.content.find(c => "toolUse" in c); const parsed = SimplifiedSummary.safeParse(block?.toolUse?.input)`; on failure, append the zod issues as a second user turn and call once more; on second failure mark the job `failed`. Guard `stopReason === "max_tokens"` by raising `maxTokens` to 4096 for full summaries. Schema comes from `z.toJSONSchema(SimplifiedSummary)` (zod 4 built-in, verified: emits draft 2020-12 with `additionalProperties: false`); strip the `$schema` key before placing it in `inputSchema.json`.

Credentials: standard AWS chain from the shell env; the client is `new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-west-2" })`. Nothing credential-related is written anywhere.

### 4.2 DynamoDB (`@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` 3.1149.0)

`verified-locally` against DynamoDB Local 1.25.1 on 2026-10-10:

```ts
import { DynamoDBClient, CreateTableCommand, UpdateTimeToLiveCommand, DescribeTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region, endpoint: process.env.DYNAMO_ENDPOINT /* http://localhost:8000 for local */,
  ...(process.env.DYNAMO_ENDPOINT ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}) });
const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

await client.send(new CreateTableCommand({ TableName,
  AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
  KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
  BillingMode: "PAY_PER_REQUEST" }));
await client.send(new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } }));
// -> { TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } }
// DescribeTimeToLive -> { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED", AttributeName: "expiresAt" } }

await doc.send(new PutCommand({ TableName, Item: { pk: "link#abc", sk: "raw", ciphertext: Buffer, iv: Buffer, tag: Buffer, keyVersion: 1, expiresAt: 1794250337 /* epoch seconds */, createdAt: iso } }));
const { Item } = await doc.send(new GetCommand({ TableName, Key: { pk: "link#abc", sk: "raw" } }));
// Item.ciphertext / iv / tag come back as Uint8Array; wrap with Buffer.from(...)
const { Items, Count } = await doc.send(new QueryCommand({ TableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "link#abc" } }));
// Count 3, sk: ["raw", "simplified", "translation#es"]
await doc.send(new QueryCommand({ TableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ExpressionAttributeValues: { ":pk": "link#abc", ":p": "translation#" } }));
await doc.send(new DeleteCommand({ TableName, Key: { pk, sk } }));   // Query then Delete each item = purge
```

TTL semantics from the AWS page (fetched): the attribute must be a Number in epoch seconds; expired items "might be deleted by the system at any time, typically within a few days after their expiration"; use filter expressions to hide expired items from reads. Hence the backend's read-time expiry check and its own purge job: the "exactly 30 days" promise is enforced by our code, with TTL as the backstop.

DynamoDB Local docker-compose (from the AWS page): `image: amazon/dynamodb-local:latest`, `command: "-jar DynamoDBLocal.jar -sharedDb -dbPath ./data"`, `ports: ["8000:8000"]`, `working_dir: /home/dynamodblocal`, volume `./docker/dynamodb:/home/dynamodblocal/data`. Any non-empty fake credentials work.

### 4.3 nodemailer 10.1.0

Verified-locally: `nodemailer.createTransport({ jsonTransport: true })` -> `sendMail()` resolves `{ messageId, message: "<json string with from,to,subject,text,headers,messageId>" }` (our console transport logs the parsed message and the link). `createTransport({ streamTransport: true, newline: "unix", buffer: true })` -> `info.message` is the RFC 822 Buffer. SES: `createTransport({ SES: { sesClient: new SESv2Client({ region }), SendEmailCommand } })` with both imported from `@aws-sdk/client-sesv2` (transport name `SESTransport`); the SES object keys must be exactly `sesClient` and `SendEmailCommand`; the legacy `{ ses, aws }` shape throws `ECONFIG`. SMTP: `createTransport("smtp://user:pass@host:587")` or `{ host, port, secure, auth: { user, pass } }`. `sendMail({ from, to, subject, text, html? })` returns `{ envelope: { from, to[] }, messageId, response }`. IAM for SES transport: `ses:SendEmail` (plus `ses:SendRawEmail` if SMTP creds are also used); the From identity must be verified, and sandbox accounts must verify recipients too.

### 4.4 SQS (`@aws-sdk/client-sqs` 3.1149.0), from installed types

`SendMessageCommand({ QueueUrl, MessageBody, DelaySeconds?, MessageAttributes? })`; `ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages?, WaitTimeSeconds?, VisibilityTimeout? })` -> `{ Messages?: [{ MessageId, ReceiptHandle, Body }] }`; `DeleteMessageCommand({ QueueUrl, ReceiptHandle })`. Lambda SQS event shape: `event.Records[].body`.

### 4.5 Amazon Transcribe Medical (`@aws-sdk/client-transcribe` 3.1149.0; doc page fetched)

Media must be in S3 first. `StartMedicalTranscriptionJobCommand({ MedicalTranscriptionJobName /* unique, [0-9a-zA-Z._-]+ */, LanguageCode: "en-US" /* only valid value */, Specialty: "PRIMARYCARE" /* only valid value for batch */, Type: "DICTATION" | "CONVERSATION", Media: { MediaFileUri: "s3://bucket/key" }, MediaFormat?: "mp3"|"mp4"|"wav"|"flac"|"ogg"|"amr"|"webm"|"m4a", OutputBucketName /* bucket name only */, OutputKey?, ContentIdentificationType?: "PHI" })`. Omit `MediaSampleRateHertz` (mismatch fails the job). Poll `GetMedicalTranscriptionJobCommand({ MedicalTranscriptionJobName })` -> `MedicalTranscriptionJob.TranscriptionJobStatus` in `QUEUED|IN_PROGRESS|COMPLETED|FAILED`, `Transcript.TranscriptFileUri`, `FailureReason`. The transcript JSON lives in `OutputBucketName/OutputKey` (read it with `GetObjectCommand`; text is at `results.transcripts[0].transcript`). S3 upload: `PutObjectCommand({ Bucket, Key, Body: buffer, ContentType })`. IAM: `transcribe:StartMedicalTranscriptionJob`, `transcribe:GetMedicalTranscriptionJob`, `s3:PutObject`, `s3:GetObject`, and Transcribe needs write access to the output bucket.

### 4.6 SES v1 client (`@aws-sdk/client-ses`), kept for reference only

`SendEmailCommand({ Source, Destination: { ToAddresses[] }, Message: { Subject: { Data, Charset? }, Body: { Text?: { Data }, Html?: { Data } } } })`. Not used because nodemailer 10 requires the v2 client.

### 4.7 pdf-parse 2.4.5 and pdfjs-dist 6.4.299

See section 3. `LoadParameters` accepts `{ data: Buffer | Uint8Array | ArrayBuffer, url?, password?, verbosity? }`; `getText({ partial?: number[], first?, last? })` returns `{ text, total, pages: [{ num, text }] }`. Engines `>=20.16 <21 || >=22.3`. Node 22.22 is fine.

### 4.8 Express 5.3, multer 2.4, zod 4.6, pino 10.4

- Express 5: rejected promises from async handlers go to the error middleware (verified). `req.body` is `undefined` until a body parser runs (multer populates `req.body` for multipart text fields).
- multer: `multer({ storage: multer.memoryStorage(), limits: { fileSize, files } })`, `upload.fields([{ name: "file", maxCount: 1 }, { name: "audio", maxCount: 1 }])`, files at `req.files.file?.[0].buffer`, `.mimetype`, `.originalname`, `.size`.
- zod 4: `z.toJSONSchema(schema)` built in; `safeParse` returns `{ success, data | error.issues }`.
- pino redaction: `pino({ redact: { paths: ["req.headers['x-provider-key']", "email", "*.email", "text", "*.text"], censor: "[redacted]" } })`; verified that `*` matches exactly one level, so top-level keys need their own entry.

### 4.9 Node crypto (built in, verified-locally)

`randomBytes(16).toString("base64url")` link id; `createHash("sha256")` hash; `createCipheriv("aes-256-gcm", key32, iv12)`, `cipher.setAAD(aad)`, `getAuthTag()` (16 bytes); `createDecipheriv(...).setAuthTag(tag)`; decryption throws on a wrong key, tag or AAD, which is the "unreadable after key destruction" test.

### 4.10 mysql2 3.24.5 (fetched: https://raw.githubusercontent.com/sidorares/node-mysql2/master/README.md , https://raw.githubusercontent.com/sidorares/node-mysql2/master/website/docs/documentation/ssl.mdx , https://raw.githubusercontent.com/sidorares/node-mysql2/master/website/docs/examples/connections/create-pool.mdx ; installed `typings/mysql/lib/Connection.d.ts` and `Pool.d.ts` are authoritative for the option names)

- Promise API: `import mysql from "mysql2/promise"; const pool = mysql.createPool({ host, port, user, password, database, ssl, waitForConnections: true, connectionLimit, maxIdle, idleTimeout, connectTimeout, enableKeepAlive, supportBigNumbers, decimalNumbers, multipleStatements: false, charset })`. `const [rows] = await pool.query(sql, params)` for SELECT (`RowDataPacket[]`), `const [result] = await pool.query(sql, params)` for writes (`ResultSetHeader.affectedRows`). `?` placeholders are escaped client-side by `query`; `execute` would use server-side prepared statements (not needed here, and `LIMIT ?` is friendlier through `query`).
- TLS (the ssl page): `ssl: { ca: fs.readFileSync(".../global-bundle.pem") }`, the same options as Node's `tls.createSecureContext`; the page recommends the AWS RDS bundle for RDS hosts (`aws-ssl-profiles` is the packaged alternative; we commit the bundle AWS step 1 downloads instead). `rejectUnauthorized: false` is called out as strongly discouraged; the backend sets `rejectUnauthorized: true, minVersion: "TLSv1.2"`.
- Upsert on MySQL/MariaDB: `INSERT ... ON DUPLICATE KEY UPDATE col = VALUES(col)`; SQLite's `ON CONFLICT (...) DO UPDATE SET col = excluded.col` is not accepted. Hence `Db.upsert()`.
- DDL differences that drove the per-dialect migration files: `TEXT` cannot be a primary key or an index (use `VARCHAR(n)` / `CHAR(64)`), `AUTOINCREMENT` is `AUTO_INCREMENT`, `BLOB` is 64 KB (use `LONGBLOB` / `VARBINARY`), inline column `REFERENCES` is ignored by InnoDB (declare `CONSTRAINT ... FOREIGN KEY`), `CREATE INDEX IF NOT EXISTS` is MariaDB-only (declare indexes inline in `CREATE TABLE`), `"double quoted"` identifiers need `ANSI_QUOTES` (use snake_case, unquoted), `||` is logical OR (use `CONCAT`).
- Not exercised live: port 3306 on the RDS host times out from the build container (`fixtures/live-samples/infra-check.2026-10-10.json`, `mysqlTcp`). The adapter is exercised with a faked pool in `test/mysql.test.ts` and the fallback with a closed local port.

### 4.11 AWS Secrets Manager (`@aws-sdk/client-secrets-manager` 3.1149.0; README fetched from https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/clients/client-secrets-manager/README.md ; `GetSecretValueCommand.d.ts` installed)

`new SecretsManagerClient({ region })`, `client.send(new GetSecretValueCommand({ SecretId: arn }))` -> `{ SecretString?: string, SecretBinary?: Uint8Array, VersionId, VersionStages, ARN, Name }`. The team secret's `SecretString` is a JSON object of string values. `verified-locally` on 2026-10-10 with the Workshop Studio role: 7 keys (`dynamodb-table`, `dynamodb-table-pk`, `mysql-db`, `mysql-host`, `mysql-password`, `mysql-port`, `mysql-user`). The console's own retrieval sample (the PDF Advik attached) shows the Workload Credentials Provider path (`curl -H "X-Aws-Parameters-Secrets-Token: $(</var/run/awssmatoken)" 'http://localhost:2773/secretsmanager/get?secretId=hackhealth/secret'`), which is the Lambda-extension / sidecar way to read the same secret; the backend uses the SDK directly. Credential failures surface as `CredentialsProviderError` ("Could not load credentials from any providers"), which the bootstrap treats as "run local".

### 4.12 DynamoDB with a single hash key (`discharge-summaries`, from the console and `DescribeTable` on 2026-10-10)

`KeySchema: [{ AttributeName: "uid", KeyType: "HASH" }]`, no sort key, TTL `ENABLED` on `expiresAt`. Without a sort key `Query` cannot list a link's documents, so the store keeps one item per link and one top-level attribute per document: `UpdateCommand({ Key: { uid }, UpdateExpression: "SET #doc = :payload, expiresAt = :exp, createdAt = if_not_exists(createdAt, :now), updatedAt = :now", ExpressionAttributeNames: { "#doc": "translation#es" }, ExpressionAttributeValues })` (attribute names may contain `#` when passed through `ExpressionAttributeNames`; binary values inside a map marshal as `B`), `GetCommand` with `ProjectionExpression: "#doc, expiresAt"`, `UpdateCommand({ UpdateExpression: "REMOVE #doc", ConditionExpression: "attribute_exists(#pk)", ReturnValues: "ALL_NEW" })` then `DeleteCommand` when no document remains, `DeleteCommand({ ReturnValues: "ALL_OLD" })` for the purge, `ScanCommand({ FilterExpression: "expiresAt <= :now" })` for the backstop. `verified-locally` against the real table (`fixtures/live-samples/infra-check.2026-10-10.json`). A teammate's item `uid = test-001` was present in the table and left untouched.

### 4.13 S3 lifecycle on `emraudio-rh` (`GetBucketLifecycleConfigurationCommand` on 2026-10-10)

`Rules: [{ ID: "autodelete", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 30 } }]`: the whole bucket already expires at 30 days, so `scripts/ensure-s3-lifecycle.ts` verifies and adds nothing (`ruleCoversAudio` in `src/audiostore/s3.ts`: enabled, `Expiration.Days <= 30`, prefix covers `audio/`, no tag or size filters). `HeadBucketCommand` is the reachability probe behind `AUDIO_STORE=auto`. `PutObject` with `ServerSideEncryption: "AES256"`, `Metadata`, `Tagging: "expiresAt=<epoch>"`; `HeadObject` returns `Metadata` and `ContentLength`; `GetObject` `Body.transformToByteArray()`. `verified-locally` put / head / get / delete of a sealed non-PHI probe object.

## 5. Stack decision

Follow the spec's stack: Node 22 + TypeScript (ESM, NodeNext), Express 5 with zod 4, pino, better-sqlite3 for local dev and tests with the team's RDS MariaDB via mysql2 behind the same repository layer (Postgres removed), DynamoDB via lib-dynamodb on the team table with a SQL twin, Secrets Manager for the infrastructure config, nodemailer (console | SMTP | SES v2) with an optional SQS worker, pdf-parse 2 with pdfjs-dist fallback, p-queue persisted in SQL, swagger-ui-express, vitest + supertest. Two deviations forced by verification: use `@aws-sdk/client-sesv2` (not client-ses) because nodemailer 10 demands it, and do not add `@types/nodemailer` or `dosis`. Default LLM provider is Bedrock Converse with tool-based JSON because it is the only provider verified live in this container.

## 6. Risks found during research

- Temporary AWS session credentials expire within hours; the live Example 1 ingest in the build stage must be run early and its output saved under `fixtures/live-samples/`.
- DynamoDB TTL deletion lag (days) means TTL alone cannot satisfy "exactly 30 days"; the purge job plus read-time checks are the enforcement, TTL is the backstop. Say so in README.
- Transcribe Medical requires an S3 bucket and the job is asynchronous (seconds to minutes); only the offline transcript provider can be demoed without an account. English only for batch medical jobs.
- Docker is not available in this container, so `docker-compose.yml` is written from the AWS page but exercised only via the jar path here.
- The published `dosis` package is broken; the fidelity normalizer is hand-written and must be unit-tested on ratio doses (875/125 mg), decimals (0.4 mg) and unit words (milligrams).
- The teammates' frontend has no API calls yet; publish the endpoint table early so they build against it.
- `toolChoice: { tool }` is documented for Claude 3 and Nova only; it worked live on the 4.x profiles in this account, but keep the `auto` + system-line path (also verified) as the fallback if a future model rejects it.
