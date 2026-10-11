import { loadDotEnv } from "../src/dotenv.js";
import { loadConfig } from "../src/config.js";
import { newSumId } from "../src/crypto/sumId.js";
import { DischargeAgent } from "../src/pipeline/agent.js";
import { adaptSummary } from "./verification/planAdapter.js";

// Calls a live runtime without SQL/DynamoDB writes or email. Credentials use the normal AWS chain.
loadDotEnv();
const config = loadConfig();
const notes = "Synthetic verification case; no real patient. Discharge diagnosis: heart failure. " +
  "New medication: furosemide 40 mg by mouth once daily. Weigh yourself each morning. " +
  "Follow up with cardiology within 1 week. Call 911 for chest pain.";
const agent = new DischargeAgent({
  runtimeArn: config.AGENT_RUNTIME_ARN, qualifier: config.AGENT_QUALIFIER,
  region: config.AWS_REGION, timeoutMs: config.AGENT_TIMEOUT_MS,
});
console.log(JSON.stringify({ check: "live-agent", runtimeArn: config.AGENT_RUNTIME_ARN, phase: "invoking", input: "synthetic notes" }));
try {
  const run = await agent.invoke(notes, newSumId());
  const response = run.response && typeof run.response === "object" ? run.response as Record<string, unknown> : {};
  const adapted = adaptSummary({
    sumId: run.sessionId, patientID: "synthetic", status: "ready", "llm-summary": run.response,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), daysLeft: 30,
  });
  const contractMatches = ["status", "flags", "summary", "plan"].every(k => k in response)
    && typeof response.status === "string" && Array.isArray(response.flags)
    && typeof response.summary === "string" && response.summary.trim().length > 0;
  console.log(JSON.stringify({
    check: "live-agent", runtimeArn: config.AGENT_RUNTIME_ARN, phase: "finished",
    invocationSucceeded: true, contractMatches, responseKeys: Object.keys(response),
    agentStatus: response.status ?? null, latencyMs: run.latencyMs,
    summaryCharacters: typeof response.summary === "string" ? response.summary.length : 0,
    resultCharacters: typeof response.result === "string" ? response.result.length : 0,
    outputContainsInputMedicine: /furosemide/i.test(adapted.summary),
    structuredPlanRecognized: !!adapted.record.byLang.en,
    summaryTextPresent: adapted.summary.trim().length > 0,
  }, null, 2));
  if (!contractMatches) process.exitCode = 1;
} catch (error) {
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  console.log(JSON.stringify({ check: "live-agent", runtimeArn: config.AGENT_RUNTIME_ARN,
    phase: "failed", invocationSucceeded: false, error: e.name, message: e.message?.slice(0, 500), statusCode: e.$metadata?.httpStatusCode ?? null }, null, 2));
  process.exitCode = 1;
}
