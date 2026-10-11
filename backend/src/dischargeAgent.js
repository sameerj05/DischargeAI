// Calls the DischargeAI agent deployed on Amazon Bedrock AgentCore Runtime.
// Usage in server.js:
//   import { generateGoingHomePlan } from "./dischargeAgent.js";
//   const { record, status, flags, translations } = await generateGoingHomePlan(notes, sessionId);
//   // record = { createdAt, byLang: { en, es, zh, ar } } — the frontend's DischargeRecord (frontend/src/data.ts).
//   // Store it as-is and return it from GET /output/:patientId. A language whose translation
//   // failed is missing from byLang; translations[lang].status says why ("failed" / "needs_review").
//
// Requires: npm install @aws-sdk/client-bedrock-agentcore
// Env: AGENT_RUNTIME_ARN (from `agentcore status`), AWS_REGION (us-west-2)
// The backend's IAM role needs bedrock-agentcore:InvokeAgentRuntime on that ARN.

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";

const client = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION || "us-west-2",
  // A run can take several minutes (the agent stops itself before 13 minutes).
  requestHandler: new NodeHttpHandler({ requestTimeout: 15 * 60 * 1000 }),
});

export async function generateGoingHomePlan(notes, sessionId = randomUUID() + "-" + randomUUID()) {
  const res = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: process.env.AGENT_RUNTIME_ARN,
    runtimeSessionId: sessionId,            // must be 33+ chars; reuse it for multi-turn
    payload: JSON.stringify({ prompt: notes }),
    contentType: "application/json",
    accept: "application/json",
  }));
  const text = await res.response.transformToString();
  return JSON.parse(text);                 // { result: "<Markdown>", status, flags, record, translations }
}
