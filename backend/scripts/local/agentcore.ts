import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { loadConfig } from "../../src/config.js";
import { DischargeAgent } from "../../src/pipeline/agent.js";

/** Explicit opt-in. Normal local tests never read AWS configuration or instantiate this client. */
export function createLocalLiveAgent(opts: { env?: Record<string, string | undefined>; client?: BedrockAgentCoreClient } = {}) {
  const env = opts.env ?? process.env;
  const runtimeArn = env.AGENT_RUNTIME_ARN?.trim();
  const target = runtimeArn?.match(/^arn:aws(?:-us-gov|-cn)?:bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/([A-Za-z0-9_-]+)$/);
  if (!target) throw new Error("local:ai requires an explicit AGENT_RUNTIME_ARN for an authorized AgentCore runtime. No fixture fallback is enabled.");
  const config = loadConfig({ AWS_REGION: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? target[1],
    AGENT_TIMEOUT_MS: env.AGENT_TIMEOUT_MS, AGENT_QUALIFIER: env.AGENT_QUALIFIER, AGENT_RUNTIME_ARN: runtimeArn });
  if (config.AWS_REGION !== target[1]) throw new Error("AWS_REGION must match the region in AGENT_RUNTIME_ARN");
  if (config.AGENT_TIMEOUT_MS < 1000) throw new Error("AGENT_TIMEOUT_MS must be at least 1000");
  return new DischargeAgent({ runtimeArn: config.AGENT_RUNTIME_ARN, region: config.AWS_REGION,
    timeoutMs: config.AGENT_TIMEOUT_MS, qualifier: config.AGENT_QUALIFIER, client: opts.client });
}
