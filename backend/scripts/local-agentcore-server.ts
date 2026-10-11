import { startLocalServer } from "./local-server.js";
import { createLocalLiveAgent } from "./local/agentcore.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { ElevenLabsReadAloud } from "../src/pipeline/readAloud.js";
import { MedicalLiveDictation } from "../src/pipeline/liveDictation.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();

const agent = createLocalLiveAgent();
const port = Number(process.env.LOCAL_TEST_PORT ?? "4000");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LOCAL_TEST_PORT must be 1–65535");
try {
  const local = await startLocalServer(port, { agent, liveDictation: new MedicalLiveDictation(config.TRANSCRIBE_STREAMING_REGION), dataDir: resolve(process.env.LOCAL_DATA_DIR ?? "../.local-data"),
    readAloud: config.ELEVENLABS_API_KEY ? new ElevenLabsReadAloud(config) : undefined });
  await local.ctx.purge();
  const purgeTimer = setInterval(() => { void local.ctx.purge().catch(error => console.error("Local purge failed:", error.message)); }, 60_000);
  purgeTimer.unref();
  console.log(`Local storage + LIVE AI: ${local.origin}\nAgentCore: ${agent.runtimeArn}\nDoctor: rivera@demo.health / demo1234\nSwagger: ${local.origin}/api/docs/ (provider key: local-test-key)\nLive dictation: ${local.ctx.liveDictation?.name ?? "unavailable"} (${config.TRANSCRIBE_STREAMING_REGION}); translation: from the AgentCore plan; read-aloud: ${local.ctx.readAloud?.name ?? "unavailable"}\nExternal provider permissions are checked when called. Emails are captured locally. Local data persists in .local-data and expires after 30 days.`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void local.close().then(() => { agent.close(); process.exit(0); });
  });
} catch (error) { agent.close(); throw error; }
