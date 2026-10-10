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

  DATABASE_FILE: z.string().default("data/app.db"),
  DATABASE_URL: optionalString,

  DOC_STORE: z.enum(["local", "dynamo"]).default("local"),
  DYNAMO_TABLE: z.string().default("discharge_records"),
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
