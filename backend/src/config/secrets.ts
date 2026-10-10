import type { Logger } from "../logger.js";

/**
 * Config bootstrap from AWS Secrets Manager (the team's `hackhealth/secret`).
 *
 * When `AWS_SECRET_ARN` is set (it defaults to the team secret) and AWS credentials resolve, the
 * secret is fetched once at startup and its keys fill the matching env vars that are still empty:
 *
 *   mysql-host -> MYSQL_HOST       mysql-port -> MYSQL_PORT     mysql-user -> MYSQL_USER
 *   mysql-password -> MYSQL_PASSWORD   mysql-db -> MYSQL_DATABASE
 *   dynamodb-table -> DYNAMO_TABLE     dynamodb-table-pk -> DYNAMO_PK
 *
 * An env var that is already set wins over the secret. With no credentials (a laptop, CI, the test
 * suite) nothing is fetched and the app runs fully local: SQLite, the SQL twin of the document
 * table, offline providers. Only the SOURCE is logged (which keys were applied, which were skipped),
 * never a value. `SECRETS_BOOTSTRAP=off` or `AWS_SECRET_ARN=` (empty) disables the fetch.
 */
export const DEFAULT_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q";

export const SECRET_KEY_MAP: Readonly<Record<string, string>> = {
  "mysql-host": "MYSQL_HOST",
  "mysql-port": "MYSQL_PORT",
  "mysql-user": "MYSQL_USER",
  "mysql-password": "MYSQL_PASSWORD",
  "mysql-db": "MYSQL_DATABASE",
  "dynamodb-table": "DYNAMO_TABLE",
  "dynamodb-table-pk": "DYNAMO_PK",
};

export type Env = Record<string, string | undefined>;

export interface SecretBootstrap {
  /** The env to build the Config from: the input plus whatever the secret filled in. */
  env: Env;
  /** Where the infrastructure config came from. */
  source: "env" | "secret" | "env+secret" | "none";
  /** True when the secret was fetched and parsed. */
  loaded: boolean;
  secretArn?: string;
  /** Secret keys found (names only). */
  keys: string[];
  /** Env vars filled from the secret. */
  applied: string[];
  /** Env vars that were already set and therefore kept. */
  kept: string[];
  /** Secret keys the backend does not know. */
  unknownKeys: string[];
  /** Why the secret was not used, when it was not. */
  reason?: "disabled" | "no_credentials" | "timeout" | "error";
  error?: string;
}

export type SecretFetcher = (arn: string, region: string) => Promise<Record<string, string>>;

/** Default fetcher: Secrets Manager GetSecretValue over the standard AWS credential chain. */
export const fetchSecretFromAws: SecretFetcher = async (arn, region) => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region });
  try {
    const r = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!r.SecretString) throw new Error("secret has no SecretString (binary secrets are not supported)");
    const parsed = JSON.parse(r.SecretString) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("secret is not a JSON object");
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = String(v);
    return out;
  } finally {
    client.destroy();
  }
};

function isCredentialsError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? "";
  const msg = (e?.message ?? "").toLowerCase();
  return name === "CredentialsProviderError" || name === "CredentialsError" || msg.includes("could not load credentials") || msg.includes("credential");
}

export async function bootstrapSecrets(
  input: Env,
  log?: Logger,
  opts: { fetch?: SecretFetcher; timeoutMs?: number } = {},
): Promise<SecretBootstrap> {
  const env: Env = { ...input };
  const base: SecretBootstrap = { env, source: "env", loaded: false, keys: [], applied: [], kept: [], unknownKeys: [] };
  const mode = (env.SECRETS_BOOTSTRAP ?? "auto").trim().toLowerCase();
  const arn = env.AWS_SECRET_ARN === undefined ? DEFAULT_SECRET_ARN : env.AWS_SECRET_ARN.trim();
  if (mode === "off" || mode === "false" || mode === "0" || !arn) {
    log?.info({ source: "env", reason: "disabled" }, "config bootstrap: Secrets Manager disabled; using env only");
    return { ...base, reason: "disabled" };
  }
  base.secretArn = arn;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-west-2";
  const fetch = opts.fetch ?? fetchSecretFromAws;
  const timeoutMs = opts.timeoutMs ?? 8000;

  let secret: Record<string, string>;
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("secret fetch timed out"), { name: "SecretTimeout" })), timeoutMs);
      timer.unref();
    });
    try {
      secret = await Promise.race([fetch(arn, region), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const reason: SecretBootstrap["reason"] = e?.name === "SecretTimeout" ? "timeout" : isCredentialsError(err) ? "no_credentials" : "error";
    log?.[reason === "no_credentials" ? "info" : "warn"](
      { source: "env", reason, errorName: e?.name, secretArn: arn },
      reason === "no_credentials"
        ? "config bootstrap: no AWS credentials; running fully local (SQLite, local document store, offline providers)"
        : "config bootstrap: could not read the secret; using env only",
    );
    return { ...base, reason, error: String(e?.message ?? err).slice(0, 200) };
  }

  const keys = Object.keys(secret).sort();
  for (const k of keys) {
    const envName = SECRET_KEY_MAP[k];
    if (!envName) {
      base.unknownKeys.push(k);
      continue;
    }
    if (env[envName] !== undefined && env[envName] !== "") {
      base.kept.push(envName);
    } else {
      env[envName] = secret[k];
      base.applied.push(envName);
    }
  }
  const source: SecretBootstrap["source"] = base.applied.length === 0 ? "env" : base.kept.length ? "env+secret" : "secret";
  log?.info(
    { source, secretArn: arn, keys, applied: base.applied, kept: base.kept, unknownKeys: base.unknownKeys },
    "config bootstrap: Secrets Manager secret loaded (names only; values are never logged)",
  );
  return { ...base, keys, source, loaded: true };
}
