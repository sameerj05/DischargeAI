import { z } from "zod";

/**
 * Hard rule from the challenge brief: every patient link and its data self-destruct exactly 30 days
 * after creation. This is a constant, not an environment variable, on purpose.
 */
export const LINK_TTL_DAYS = 30;
export const LINK_TTL_MS = LINK_TTL_DAYS * 24 * 60 * 60 * 1000;

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

const int = (def: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return def;
      const n = typeof v === "number" ? v : Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : def;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

export const ConfigSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: int(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  PATIENT_APP_URL: z.string().default("http://localhost:5173"),
  PROVIDER_API_KEY: z.string().min(1).default("dev-provider-key"),
  DEMO_MODE: bool.default(true),
  PURGE_INTERVAL_MS: int(60_000),
  MAX_UPLOAD_BYTES: int(15 * 1024 * 1024),

  /**
   * Config bootstrap: the team secret (src/config/secrets.ts). `auto` fetches it when AWS
   * credentials resolve and fills the MYSQL_* / DYNAMO_* values below that are still empty.
   */
  SECRETS_BOOTSTRAP: z.enum(["auto", "off"]).default("auto"),
  AWS_SECRET_ARN: z.string().default("arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q"),

  /** SQL: auto = MySQL/MariaDB when MYSQL_HOST (env or secret) is set, else SQLite. */
  SQL_DRIVER: z.enum(["auto", "sqlite", "mysql"]).default("auto"),
  DATABASE_FILE: z.string().default("data/app.db"),
  /** mysql://user:pass@host:3306/db also works; MYSQL_* and the secret are the documented path. */
  DATABASE_URL: optionalString,
  MYSQL_HOST: optionalString,
  MYSQL_PORT: int(3306),
  MYSQL_USER: optionalString,
  MYSQL_PASSWORD: optionalString,
  MYSQL_DATABASE: z.string().default("dischargeai"),
  /** AWS connection step 1: the RDS global CA bundle (scripts/fetch-rds-bundle.sh). */
  RDS_CA_BUNDLE: z.string().default("certs/global-bundle.pem"),
  MYSQL_SSL: z.enum(["required", "off"]).default("required"),

  /** auto = DynamoDB when the team secret loaded (credentials present), else the SQL twin. */
  DOC_STORE: z.enum(["auto", "local", "dynamo"]).default("auto"),
  /** The team's table and its hash key; Secrets Manager (`dynamodb-table`, `dynamodb-table-pk`) fills these when the secret loads. */
  DYNAMO_TABLE: z.string().default("discharge-summaries"),
  DYNAMO_PK: z.string().default("uid"),
  DYNAMO_ENDPOINT: optionalString,
  KEY_VERSION: int(1),

  LLM_PROVIDER: z.enum(["offline", "bedrock", "anthropic"]).default("offline"),
  AWS_REGION: z.string().default("us-west-2"),
  BEDROCK_MODEL_ID: z.string().default("us.anthropic.claude-sonnet-4-6"),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),

  TRANSCRIBE_PROVIDER: z.enum(["offline", "aws"]).default("offline"),
  TRANSCRIBE_BUCKET: optionalString,
  TRANSCRIBE_OUTPUT_BUCKET: optionalString,

  /**
   * Where dictated audio is kept (sealed with the link key): the team's S3 bucket or a local
   * directory. auto = the bucket when the team secret loaded and HeadBucket succeeds, else local.
   */
  AUDIO_STORE: z.enum(["auto", "local", "s3"]).default("auto"),
  AUDIO_BUCKET: z.string().default("emraudio-rh"),
  AUDIO_DIR: z.string().default("data/audio"),

  EMAIL_TRANSPORT: z.enum(["console", "smtp", "ses"]).default("console"),
  EMAIL_FROM: z.string().default("DischargeAI <noreply@example.test>"),
  SMTP_URL: optionalString,
  EMAIL_QUEUE: z.enum(["none", "sqs"]).default("none"),
  SQS_QUEUE_URL: optionalString,
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parse config from an env-like object. Unknown keys are ignored; empty strings fall back to defaults. */
export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  // AWS_DEFAULT_REGION is the boto-style spelling; honour it when AWS_REGION is unset.
  if (!cleaned.AWS_REGION && cleaned.AWS_DEFAULT_REGION) cleaned.AWS_REGION = cleaned.AWS_DEFAULT_REGION;
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return applyMysqlUrl({ ...parsed.data, ...overrides });
}

/** DATABASE_URL=mysql://user:pass@host:3306/db fills the MYSQL_* fields that are still empty. */
function applyMysqlUrl(config: Config): Config {
  if (!config.DATABASE_URL || !/^mysql2?:\/\//i.test(config.DATABASE_URL)) return config;
  const u = new URL(config.DATABASE_URL);
  return {
    ...config,
    MYSQL_HOST: config.MYSQL_HOST ?? (u.hostname || undefined),
    MYSQL_PORT: u.port ? Number.parseInt(u.port, 10) : config.MYSQL_PORT,
    MYSQL_USER: config.MYSQL_USER ?? (u.username ? decodeURIComponent(u.username) : undefined),
    MYSQL_PASSWORD: config.MYSQL_PASSWORD ?? (u.password ? decodeURIComponent(u.password) : undefined),
    MYSQL_DATABASE: u.pathname.length > 1 ? decodeURIComponent(u.pathname.slice(1)) : config.MYSQL_DATABASE,
  };
}

/** The SQL driver `auto` resolves to: MySQL when a host is known, else SQLite. */
export function resolveSqlDriver(config: Pick<Config, "SQL_DRIVER" | "MYSQL_HOST">): "sqlite" | "mysql" {
  if (config.SQL_DRIVER !== "auto") return config.SQL_DRIVER;
  return config.MYSQL_HOST ? "mysql" : "sqlite";
}

/** The document store `auto` resolves to: DynamoDB when the team secret loaded or an endpoint is set, else the SQL twin. */
export function resolveDocStore(config: Pick<Config, "DOC_STORE" | "DYNAMO_ENDPOINT">, secretLoaded: boolean): "local" | "dynamo" {
  if (config.DOC_STORE !== "auto") return config.DOC_STORE;
  return secretLoaded || !!config.DYNAMO_ENDPOINT ? "dynamo" : "local";
}
