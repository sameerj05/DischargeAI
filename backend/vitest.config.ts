import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: true,
    env: {
      NODE_ENV: "test",
      SECRETS_BOOTSTRAP: "off",
      SQL_DRIVER: "sqlite",
      LLM_PROVIDER: "offline",
      TRANSCRIBE_PROVIDER: "offline",
      DOC_STORE: "local",
      EMAIL_TRANSPORT: "console",
      EMAIL_QUEUE: "none",
      DEMO_MODE: "true",
      PURGE_INTERVAL_MS: "0",
      DATABASE_FILE: ":memory:",
      LOG_LEVEL: "silent",
      PROVIDER_API_KEY: "test-provider-key",
    },
  },
});
