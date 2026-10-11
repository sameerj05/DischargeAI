import type { Logger } from "./logger.js";

/**
 * Config bootstrap from AWS Secrets Manager. The team secret `hackhealth/secret` holds the MariaDB
 * connection values and the DynamoDB table and key names. At startup, when `SECRETS_BOOTSTRAP` is
 * `auto` (default) and `AWS_SECRET_ARN` is set, GetSecretValue is called once and its keys are
 * mapped onto environment variables; a variable that is already set in the environment wins. When
 * no AWS credentials resolve (a laptop with no profile), the call fails fast, a warning names the
 * reason, and the app runs fully local. Values are never logged; only key names are.
 */
export const DEFAULT_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q";

/** Secret key -> environment variable it feeds. `mysql-db` is the database to USE; tables are created inside it. */
export const SECRET_KEY_TO_ENV: Record<string, string> = {
  "mysql-host": "MYSQL_HOST",
  "mysql-port": "MYSQL_PORT",
  "mysql-user": "MYSQL_USER",
  "mysql-password": "MYSQL_PASSWORD",
  "mysql-db": "MYSQL_DATABASE",
  "dynamodb-table": "DYNAMO_TABLE",
  "dynamodb-table-pk": "DYNAMO_PK",
};

export type SecretsSource = "secrets-manager" | "env" | "none";

export interface SecretsBootstrapResult {
  /** secrets-manager: the secret was read and applied; env: bootstrap is off; none: the call failed and local defaults apply. */
  source: SecretsSource;
  arn?: string;
  region?: string;
  /** Environment variables filled from the secret (names only). */
  applied: string[];
  /** Secret keys that were present but ignored because the environment already set the variable. */
  overriddenByEnv: string[];
  /** Expected secret keys that were absent (the config default applies, e.g. MYSQL_DATABASE=dischargeai). */
  missingKeys: string[];
  /** Why the secret was not used, when it was not. Error class and message only, never a value. */
  reason?: string;
  ms: number;
}

type Env = Record<string, string | undefined>;

/** Pure: overlays the secret onto a copy of the environment. Existing (non-empty) env values win. */
export function applySecretToEnv(secret: Record<string, unknown>, env: Env): { env: Env; applied: string[]; overriddenByEnv: string[]; missingKeys: string[] } {
  const out: Env = { ...env };
  const applied: string[] = [];
  const overriddenByEnv: string[] = [];
  const missingKeys: string[] = [];
  for (const [key, variable] of Object.entries(SECRET_KEY_TO_ENV)) {
    const value = secret[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      missingKeys.push(key);
      continue;
    }
    if (out[variable] !== undefined && out[variable] !== "") {
      overriddenByEnv.push(variable);
      continue;
    }
    out[variable] = String(value);
    applied.push(variable);
  }
  return { env: out, applied, overriddenByEnv, missingKeys };
}

export type SecretFetcher = (arn: string, region: string, timeoutMs: number) => Promise<Record<string, unknown>>;

/** GetSecretValue with a hard timeout, so a laptop without credentials is not stuck probing for them. */
export const fetchSecretFromAws: SecretFetcher = async (arn, region, timeoutMs) => {
  const { GetSecretValueCommand, SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const r = await client.send(new GetSecretValueCommand({ SecretId: arn }), { abortSignal: abort.signal });
    const text = r.SecretString ?? (r.SecretBinary ? Buffer.from(r.SecretBinary).toString("utf8") : "");
    if (!text) throw new Error("secret has no SecretString");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("secret is not a JSON object of key/value pairs");
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    client.destroy();
  }
};

export interface BootstrapOptions {
  log?: Logger;
  fetcher?: SecretFetcher;
  timeoutMs?: number;
}

export async function bootstrapSecrets(env: Env, opts: BootstrapOptions = {}): Promise<{ env: Env; result: SecretsBootstrapResult }> {
  const t0 = Date.now();
  const mode = (env.SECRETS_BOOTSTRAP ?? "auto").trim().toLowerCase();
  const arn = (env.AWS_SECRET_ARN ?? DEFAULT_SECRET_ARN).trim();
  const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2").trim();
  if (mode === "off" || !arn) {
    const result: SecretsBootstrapResult = { source: "env", applied: [], overriddenByEnv: [], missingKeys: [], reason: mode === "off" ? "SECRETS_BOOTSTRAP=off" : "AWS_SECRET_ARN is empty", ms: 0 };
    opts.log?.info({ source: result.source, reason: result.reason }, "config: environment only");
    return { env, result };
  }
  try {
    const secret = await (opts.fetcher ?? fetchSecretFromAws)(arn, region, opts.timeoutMs ?? 5000);
    const applied = applySecretToEnv(secret, env);
    const result: SecretsBootstrapResult = { source: "secrets-manager", arn, region, applied: applied.applied, overriddenByEnv: applied.overriddenByEnv, missingKeys: applied.missingKeys, ms: Date.now() - t0 };
    opts.log?.info({ source: result.source, arn, applied: result.applied, overriddenByEnv: result.overriddenByEnv, missingKeys: result.missingKeys, ms: result.ms }, "config: Secrets Manager values applied (names only)");
    return { env: applied.env, result };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const reason = `${e?.name ?? "Error"}: ${String(e?.message ?? err).slice(0, 160)}`;
    const result: SecretsBootstrapResult = { source: "none", arn, region, applied: [], overriddenByEnv: [], missingKeys: [], reason, ms: Date.now() - t0 };
    opts.log?.warn({ source: result.source, arn, reason, ms: result.ms }, "config: Secrets Manager not available, running with local defaults");
    return { env, result };
  }
}
