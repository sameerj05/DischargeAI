// Historical standalone adapter. The integrated server uses backend/src/pipeline/agent.ts.
// Matches agentcore_app.py: request {notes}, response {status, flags, summary, plan}.
// Set AGENT_RUNTIME_ARN and AWS_REGION; credentials stay in the server credential chain.

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
    payload: new TextEncoder().encode(JSON.stringify({ notes })),
    contentType: "application/json",
    accept: "application/json",
  }));
  const text = await res.response.transformToString();
  return JSON.parse(text);                 // { status, flags, summary, plan } from agentcore_app.py
}
