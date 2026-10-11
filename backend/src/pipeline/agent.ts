import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/** AgentCore Runtime refuses a runtimeSessionId shorter than this. Every sum-id is longer (43 characters). */
export const MIN_SESSION_ID_LENGTH = 33;

export interface AgentRun {
  /** The agent's response exactly as it came back: parsed JSON when it is JSON, otherwise the text. */
  response: unknown;
  sessionId: string;
  latencyMs: number;
}

/**
 * The team's DischargeAI agent on Amazon Bedrock AgentCore Runtime (AI-Infra branch, entrypoint
 * agentcore_app.py). Request body {"notes": "<clinician text>"}; the live runtime answers
 * {"status", "flags", "summary", "plan"} and that whole object is kept as it is. The session id is
 * the summary's sum-id, so one summary is one AgentCore session (and one microVM).
 * A run can take minutes: the request times out after AGENT_TIMEOUT_MS (AgentCore's own limit for a
 * synchronous call is 15 minutes), and it is never retried, because a retry would run the whole
 * graph again.
 * IAM: bedrock-agentcore:InvokeAgentRuntime on AGENT_RUNTIME_ARN.
 */
export class DischargeAgent {
  readonly name = "agentcore";
  private readonly client: BedrockAgentCoreClient;

  constructor(
    private readonly opts: { runtimeArn: string; qualifier?: string; region: string; timeoutMs: number; log?: Logger },
  ) {
    this.client = new BedrockAgentCoreClient({
      region: opts.region,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 10_000, requestTimeout: opts.timeoutMs, throwOnRequestTimeout: true },
    });
  }

  get runtimeArn(): string {
    return this.opts.runtimeArn;
  }

  async invoke(notes: string, sessionId: string): Promise<AgentRun> {
    if (sessionId.length < MIN_SESSION_ID_LENGTH) throw new Error(`AgentCore session ids must be at least ${MIN_SESSION_ID_LENGTH} characters (got ${sessionId.length})`);
    const t0 = Date.now();
    const res = await this.client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: this.opts.runtimeArn,
        runtimeSessionId: sessionId,
        ...(this.opts.qualifier ? { qualifier: this.opts.qualifier } : {}),
        contentType: "application/json",
        accept: "application/json",
        payload: new TextEncoder().encode(JSON.stringify({ notes })),
      }),
    );
    const text = (await res.response?.transformToString()) ?? "";
    const response = parseResponse(text);
    const latencyMs = Date.now() - t0;
    if (isAgentError(response)) throw new Error(`agent_error: ${String(response.error).slice(0, 300)}`);
    this.opts.log?.info({ latencyMs, statusCode: res.statusCode }, "agent answered");
    return { response, sessionId, latencyMs };
  }
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The agent reports a refused request as {"error": "..."} and nothing else. */
function isAgentError(response: unknown): response is { error: unknown } {
  return !!response && typeof response === "object" && !Array.isArray(response) && Object.keys(response).length === 1 && "error" in response;
}

export function createAgent(config: Config, log: Logger): DischargeAgent {
  return new DischargeAgent({ runtimeArn: config.AGENT_RUNTIME_ARN, qualifier: config.AGENT_QUALIFIER, region: config.AWS_REGION, timeoutMs: config.AGENT_TIMEOUT_MS, log });
}
