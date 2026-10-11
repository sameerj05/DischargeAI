import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { DischargeAgent } from "../src/pipeline/agent.js";
import { loadConfig } from "../src/config.js";

function agentWithResponse(body: string) {
  const requests: { body?: unknown; headers: Record<string, string> }[] = [];
  const client = new BedrockAgentCoreClient({
    region: "us-west-2", credentials: { accessKeyId: "TESTKEY", secretAccessKey: "TESTSECRET" }, maxAttempts: 1,
    requestHandler: { handle: async request => {
      requests.push(request);
      return { response: { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([body]) } };
    } },
  });
  const agent = new DischargeAgent({ runtimeArn: loadConfig({}).AGENT_RUNTIME_ARN, region: "us-west-2", qualifier: "DEFAULT", timeoutMs: 1000, client });
  return { agent, requests, client };
}

test("the backend's AWS request matches the AI-Infra entrypoint and deployed runtime", async () => {
  const response = { status: "approved", flags: [], summary: "Plan", plan: { schedule: {} } };
  const h = agentWithResponse(JSON.stringify(response));
  try {
    const result = await h.agent.invoke("Clinician notes", "A".repeat(43));
    const requestBody = h.requests[0].body;
    const encoded = typeof requestBody === "string" ? requestBody : Buffer.from(requestBody as Uint8Array).toString();
    assert.deepEqual(JSON.parse(encoded), { notes: "Clinician notes" });
    assert.equal(h.requests[0].headers["x-amzn-bedrock-agentcore-runtime-session-id"], "A".repeat(43));
    assert.deepEqual(result.response, response);
    const root = join(import.meta.dirname, "..", "..", "AI-Infra");
    const deployed = JSON.parse(readFileSync(join(root, "agentcore", ".cli", "deployed-state.json"), "utf8"));
    assert.equal(loadConfig({}).AGENT_RUNTIME_ARN, deployed.targets.default.resources.runtimes.DischargeAI.runtimeArn);
    const config = JSON.parse(readFileSync(join(root, "agentcore", "agentcore.json"), "utf8"));
    assert.equal(config.runtimes[0].entrypoint, "agent.py");
    assert.match(readFileSync(join(root, "agent.py"), "utf8"), /payload\.get\("notes"\)/);
    await assert.rejects(h.agent.invoke("Clinician notes", "short"), /at least 33/);
    assert.equal(h.requests.length, 1, "short sessions never reach AWS");
  } finally { h.client.destroy(); }
});

test("empty responses and runtime error objects fail the agent call", async () => {
  for (const [body, error] of [["", /empty response/], ['{"error":"invalid notes"}', /agent_error/]] as const) {
    const h = agentWithResponse(body);
    try { await assert.rejects(h.agent.invoke("Notes", "B".repeat(43)), error); }
    finally { h.client.destroy(); }
  }
});
