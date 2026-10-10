import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, resolveDocStore, resolveSqlDriver } from "../src/config.js";
import { DEFAULT_SECRET_ARN, SECRET_KEY_MAP, bootstrapSecrets, type SecretFetcher } from "../src/config/secrets.js";
import { createContext } from "../src/context.js";

/** What the team secret holds (names from the console; values here are placeholders, never the real ones). */
const SECRET = {
  "dynamodb-table": "discharge-summaries",
  "dynamodb-table-pk": "uid",
  "mysql-host": "patients.example.us-west-2.rds.amazonaws.com",
  "mysql-port": "3306",
  "mysql-user": "admin",
  "mysql-password": "placeholder-not-the-real-password",
  "mysql-db": "dischargeai",
};
const fetchOk: SecretFetcher = async () => ({ ...SECRET });

describe("config bootstrap from Secrets Manager", () => {
  it("fills the empty MYSQL_* and DYNAMO_* vars from the secret and reports names only", async () => {
    const seen: string[] = [];
    const r = await bootstrapSecrets({ AWS_REGION: "us-west-2" }, undefined, {
      fetch: async (arn, region) => {
        seen.push(arn, region);
        return { ...SECRET };
      },
    });
    expect(seen).toEqual([DEFAULT_SECRET_ARN, "us-west-2"]);
    expect(r.loaded).toBe(true);
    expect(r.source).toBe("secret");
    expect(r.keys).toEqual(Object.keys(SECRET).sort());
    expect(r.applied.sort()).toEqual(Object.values(SECRET_KEY_MAP).sort());
    expect(r.kept).toEqual([]);
    expect(r.unknownKeys).toEqual([]);
    expect(r.env.MYSQL_HOST).toBe(SECRET["mysql-host"]);
    expect(r.env.MYSQL_PASSWORD).toBe(SECRET["mysql-password"]);
    expect(r.env.DYNAMO_TABLE).toBe("discharge-summaries");
    expect(r.env.DYNAMO_PK).toBe("uid");
    expect(r.env.MYSQL_DATABASE).toBe("dischargeai");
    // The report object the health endpoint shows never carries a value.
    const { env: _env, ...report } = r;
    void _env;
    expect(JSON.stringify(report)).not.toContain(SECRET["mysql-password"]);
    expect(JSON.stringify(report)).not.toContain(SECRET["mysql-host"]);
    const config = loadConfig(r.env);
    expect(config.MYSQL_PORT).toBe(3306);
    expect(resolveSqlDriver(config)).toBe("mysql");
    expect(resolveDocStore(config, r.loaded)).toBe("dynamo");
  });

  it("explicit env wins over the secret, unknown keys are listed, mysql-db falls back to the default", async () => {
    const r = await bootstrapSecrets({ MYSQL_HOST: "127.0.0.1", DYNAMO_TABLE: "my-table", AWS_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:1:secret:x" }, undefined, {
      fetch: async (arn) => {
        expect(arn).toBe("arn:aws:secretsmanager:us-west-2:1:secret:x");
        const { "mysql-db": _db, ...rest } = SECRET;
        void _db;
        return { ...rest, "something-else": "ignored" };
      },
    });
    expect(r.source).toBe("env+secret");
    expect(r.kept.sort()).toEqual(["DYNAMO_TABLE", "MYSQL_HOST"]);
    expect(r.applied.sort()).toEqual(["DYNAMO_PK", "MYSQL_PASSWORD", "MYSQL_PORT", "MYSQL_USER"]);
    expect(r.unknownKeys).toEqual(["something-else"]);
    expect(r.env.MYSQL_HOST).toBe("127.0.0.1");
    expect(r.env.DYNAMO_TABLE).toBe("my-table");
    expect(loadConfig(r.env).MYSQL_DATABASE).toBe("dischargeai");
  });

  it("runs fully local when the fetch is disabled, has no credentials, errors or times out", async () => {
    let calls = 0;
    const counting: SecretFetcher = async () => {
      calls += 1;
      return { ...SECRET };
    };
    for (const env of [{ SECRETS_BOOTSTRAP: "off" }, { AWS_SECRET_ARN: "" }]) {
      const r = await bootstrapSecrets(env, undefined, { fetch: counting });
      expect(r).toMatchObject({ loaded: false, source: "env", reason: "disabled", applied: [] });
    }
    expect(calls).toBe(0);

    const noCreds = await bootstrapSecrets({}, undefined, {
      fetch: async () => {
        throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
      },
    });
    expect(noCreds).toMatchObject({ loaded: false, source: "env", reason: "no_credentials" });
    expect(noCreds.env.MYSQL_HOST).toBeUndefined();
    expect(resolveSqlDriver(loadConfig(noCreds.env))).toBe("sqlite");
    expect(resolveDocStore(loadConfig(noCreds.env), noCreds.loaded)).toBe("local");

    const denied = await bootstrapSecrets({}, undefined, {
      fetch: async () => {
        throw Object.assign(new Error("User is not authorized"), { name: "AccessDeniedException" });
      },
    });
    expect(denied).toMatchObject({ loaded: false, reason: "error" });
    expect(denied.error).toContain("not authorized");

    const slow = await bootstrapSecrets({}, undefined, { fetch: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(slow).toMatchObject({ loaded: false, reason: "timeout" });
  });

  it("DATABASE_URL=mysql://... fills the MYSQL_* fields that are still empty", () => {
    const c = loadConfig({ DATABASE_URL: "mysql://admin:p%40ss@db.example:3307/other", MYSQL_HOST: "" });
    expect(c).toMatchObject({ MYSQL_HOST: "db.example", MYSQL_PORT: 3307, MYSQL_USER: "admin", MYSQL_PASSWORD: "p@ss", MYSQL_DATABASE: "other" });
    expect(resolveSqlDriver(c)).toBe("mysql");
    expect(resolveSqlDriver(loadConfig({ SQL_DRIVER: "sqlite", MYSQL_HOST: "x" }))).toBe("sqlite");
  });

  it("the app boots on the secret's values and reports the source in GET /health without values", async () => {
    const ctx = await createContext({
      env: { SECRETS_BOOTSTRAP: "auto", SQL_DRIVER: "sqlite", DOC_STORE: "local", DATABASE_FILE: ":memory:", LOG_LEVEL: "silent", PURGE_INTERVAL_MS: "0", LLM_PROVIDER: "offline", TRANSCRIBE_PROVIDER: "offline", EMAIL_QUEUE: "none", AUDIO_STORE: "local", AUDIO_DIR: "data/test-audio-secrets" },
      secretFetcher: fetchOk,
    });
    try {
      expect(ctx.boot).toMatchObject({ loaded: true, source: "secret", secretArn: DEFAULT_SECRET_ARN });
      expect(ctx.config.MYSQL_HOST).toBe(SECRET["mysql-host"]);
      expect(ctx.config.DYNAMO_TABLE).toBe("discharge-summaries");
      expect(ctx.db.dialect).toBe("sqlite");
      const res = await request(buildApp(ctx)).get("/health");
      expect(res.body.config).toMatchObject({ source: "secret", secretLoaded: true, secretArn: DEFAULT_SECRET_ARN });
      expect(res.body.config.appliedFromSecret).toContain("MYSQL_PASSWORD");
      expect(res.body.sql).toMatchObject({ dialect: "sqlite", requested: "sqlite", fallback: null });
      expect(JSON.stringify(res.body)).not.toContain(SECRET["mysql-password"]);
      expect(JSON.stringify(res.body)).not.toContain(SECRET["mysql-host"]);
    } finally {
      await ctx.close();
    }
  });
});
