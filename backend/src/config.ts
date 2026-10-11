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
  PORT: int(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  PATIENT_APP_URL: z.string().default("http://localhost:5173"),
  PROVIDER_API_KEY: z.string().min(1).default("dev-provider-key"),
  /** Pins the app clock to this ISO-8601 moment at boot (demo of day 30). Unset in production. */
  DEMO_NOW: optionalString,

  /** auto: read hackhealth/secret at startup when credentials resolve; off: environment only. */
  SECRETS_BOOTSTRAP: z.enum(["auto", "off"]).default("auto"),
  AWS_SECRET_ARN: z.string().default("arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q"),
  PURGE_INTERVAL_MS: int(60_000),
  /**
   * The purge refuses to run with DEMO_NOW set against DynamoDB or S3: a clock pinned weeks ahead would
   * make every recent item in the shared table (and every object of this backend's links) look expired.
   * "yes" lifts that for a throwaway demo account only.
   */
  DEMO_PURGE_ON_AWS: z.enum(["no", "yes"]).default("no"),
  MAX_UPLOAD_BYTES: int(15 * 1024 * 1024),

  /** mysql://user:password@host:3306/database. Wins over MYSQL_*. */
  DATABASE_URL: optionalString,
  /** MariaDB on RDS. Filled from Secrets Manager (mysql-host, mysql-port, mysql-user, mysql-password, mysql-db) unless set here. */
  MYSQL_HOST: optionalString,
  MYSQL_PORT: int(3306),
  MYSQL_USER: optionalString,
  MYSQL_PASSWORD: optionalString,
  MYSQL_DATABASE: z.string().default("dischargeai"),
  MYSQL_POOL_SIZE: int(5),
  /** AWS connection step 1: the public RDS certificate bundle (scripts/fetch-rds-bundle.sh). */
  RDS_CA_BUNDLE: z.string().default("certs/global-bundle.pem"),
  /** The team's patient table in the same database (the infra branch reads `SELECT * FROM patientinfo`). Read-only for this backend. */
  PATIENTS_TABLE: z.string().regex(/^[A-Za-z0-9_]+$/, "a plain table name").default("patientinfo"),

  /** The team table (hash key uid, TTL expiresAt). Filled from the secret's dynamodb-table. */
  DYNAMO_TABLE: z.string().default("discharge-summaries"),
  /** Name of the table's hash key attribute (the secret's dynamodb-table-pk). */
  DYNAMO_PK: z.string().default("uid"),

  AWS_REGION: z.string().default("us-west-2"),
  /** The team's DischargeAI agent on Bedrock AgentCore Runtime. */
  AGENT_RUNTIME_ARN: z.string().default("arn:aws:bedrock-agentcore:us-west-2:183815333909:runtime/DischargeAIAgent_DischargeAI-y8mQ6FEN5u"),
  /** AgentCore endpoint name; unset means the runtime's DEFAULT endpoint. */
  AGENT_QUALIFIER: optionalString,
  /** How long one agent run may take before the job fails (AgentCore stops a synchronous call at 15 minutes). */
  AGENT_TIMEOUT_MS: int(15 * 60 * 1000),

  TRANSCRIBE_OUTPUT_BUCKET: optionalString,

  /** The team contract's PDF bucket (`arn:aws:s3:::emrpdf-rh`). */
  PDF_BUCKET: z.string().default("emrpdf-rh"),
  /** The team's audio bucket ("EMR audio"). */
  AUDIO_BUCKET: z.string().default("emraudio-rh"),
  /** Where deletion receipts go: sql (audit_log, default) or dynamo (receipt# items in the table). */
  AUDIT_SINK: z.enum(["sql", "dynamo"]).default("sql"),

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
  return { ...parsed.data, ...overrides };
}
