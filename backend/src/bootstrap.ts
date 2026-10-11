import { loadDotEnv } from "./dotenv.js";
import { createLogger, type Logger } from "./logger.js";
import { bootstrapSecrets, type SecretsBootstrapResult } from "./secrets.js";

export interface RuntimeEnv {
  env: Record<string, string | undefined>;
  secrets: SecretsBootstrapResult;
}

/**
 * The process-level configuration sequence shared by the server and every script:
 *   1. .env (values already in the environment win, so shell-sourced AWS credentials are never overridden),
 *   2. Secrets Manager (hackhealth/secret) for the MariaDB and DynamoDB settings, unless the environment set them.
 * Returns the resolved environment for loadConfig and a report (names only) for /health and logs.
 */
export async function loadRuntimeEnv(opts: { log?: Logger } = {}): Promise<RuntimeEnv> {
  loadDotEnv();
  const log = opts.log ?? createLogger(process.env.LOG_LEVEL ?? "info");
  const { env, result } = await bootstrapSecrets({ ...process.env }, { log });
  return { env, secrets: result };
}
