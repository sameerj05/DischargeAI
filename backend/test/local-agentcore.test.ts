import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { startLocalServer } from "../scripts/local-server.js";
import { createLocalLiveAgent } from "../scripts/local/agentcore.js";

const runtimeArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/TestAgent_123";
const provider = { "Content-Type": "application/json", "x-provider-key": "local-test-key" };
const post = (body: unknown): RequestInit => ({ method: "POST", headers: provider, body: JSON.stringify(body) });

test("live local mode requires an explicit runtime and the correct region", () => {
  assert.throws(() => createLocalLiveAgent({ env: {} }), /explicit AGENT_RUNTIME_ARN/);
  assert.throws(() => createLocalLiveAgent({ env: { AGENT_RUNTIME_ARN: "local-fixture" } }), /explicit AGENT_RUNTIME_ARN/);
  assert.throws(() => createLocalLiveAgent({ env: { AGENT_RUNTIME_ARN: runtimeArn, AWS_REGION: "us-east-1" } }), /region/);
});

test("the hybrid HTTP pipeline stores the SDK response and invokes no local AI fixture", async () => {
  const calls: { body: unknown; session: string }[] = [];
  const response = { result: "Generated transport-test output: Furosemide 40 mg once daily.", status: "approved", flags: [] };
  const client = new BedrockAgentCoreClient({ region: "us-west-2", maxAttempts: 1,
    credentials: { accessKeyId: "TESTKEY", secretAccessKey: "TESTSECRET" },
    requestHandler: { handle: async request => {
      const encoded = typeof request.body === "string" ? request.body : Buffer.from(request.body as Uint8Array).toString();
      calls.push({ body: JSON.parse(encoded), session: request.headers["x-amzn-bedrock-agentcore-runtime-session-id"] });
      return { response: { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([JSON.stringify(response)]) } };
    } },
  });
  const agent = createLocalLiveAgent({ env: { AGENT_RUNTIME_ARN: runtimeArn }, client });
  const local = await startLocalServer(0, { agent });
  try {
    const health = await (await fetch(local.origin + "/api/health")).json();
    assert.equal(health.mode, "local-agentcore"); assert.equal(health.providers.llm, "agentcore");
    assert.equal(health.providers.docStore, "memory"); assert.equal(health.providers.pdf, "in-memory PDF files (local test only)");
    assert.deepEqual(health.capabilities, { liveAi: true, dictation: false, translation: true, readAloud: false });
    assert.equal((await fetch(local.origin + "/api/auth/login", post({ email: "rivera@demo.health", password: "demo1234" }))).status, 200);
    const notes = "Synthetic heart failure notes. Furosemide 40 mg once daily.";
    const acceptedResponse = await fetch(local.origin + "/api/ingest", post({ patientID: "7", type: "text", data: notes }));
    assert.equal(acceptedResponse.status, 202);
    const accepted = await acceptedResponse.json(); await local.ctx.queue.onIdle();
    assert.deepEqual(calls, [{ body: { notes }, session: accepted.sumId }]);
    const summary = await (await fetch(`${local.origin}/api/p/${accepted.sumId}`)).json();
    assert.deepEqual(summary["llm-summary"], response);
    assert.equal((await local.ctx.summaries.get(accepted.sumId))?.["raw-text"], notes);
    assert.equal((await local.ctx.jobs.get(accepted.jobId))?.meta.agentRuntimeArn, runtimeArn);
    assert.equal(local.outbox.length, 2);
    const access = await fetch(local.origin + "/api/auth/link", post({ token: accepted.sumId, dob: "2000-01-01", role: "patient" }));
    assert.equal(access.status, 200);
    const form = new FormData(); form.set("patientId", "7"); form.set("audio", new Blob(["audio"]), "test.webm");
    const audio = await fetch(local.origin + "/api/ingest", { method: "POST", headers: { "x-provider-key": "local-test-key" }, body: form });
    assert.equal(audio.status, 501); assert.equal((await audio.json()).error, "live_dictation_unavailable");
    assert.equal(calls.length, 1); assert.equal(local.outbox.length, 2);
  } finally { await local.close(); agent.close(); }
});

test("an AWS invocation failure stays failed without falling back to synthetic output", async () => {
  let calls = 0;
  const client = new BedrockAgentCoreClient({ region: "us-west-2", maxAttempts: 1,
    credentials: { accessKeyId: "TESTKEY", secretAccessKey: "TESTSECRET" },
    requestHandler: { handle: async () => {
      calls++;
      return { response: { statusCode: 403, headers: { "content-type": "application/json", "x-amzn-errortype": "AccessDeniedException" },
        body: Readable.from(['{"message":"Denied by transport test"}']) } };
    } },
  });
  const agent = createLocalLiveAgent({ env: { AGENT_RUNTIME_ARN: runtimeArn }, client });
  const local = await startLocalServer(0, { agent });
  try {
    const accepted = await (await fetch(local.origin + "/api/ingest", post({ patientID: "7", type: "text", data: "Synthetic source" }))).json();
    await local.ctx.queue.onIdle();
    assert.equal((await local.ctx.jobs.get(accepted.jobId))?.stage, "failed");
    assert.equal((await local.ctx.summaries.get(accepted.sumId))?.["llm-summary"], undefined);
    assert.equal((await fetch(`${local.origin}/api/p/${accepted.sumId}`)).status, 500);
    assert.equal(calls, 1); assert.equal(local.outbox.length, 0);
  } finally { await local.close(); agent.close(); }
});
