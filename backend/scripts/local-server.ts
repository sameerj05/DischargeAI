import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { createLocalContext } from "./local/context.js";
import type { LocalProviders } from "./local/context.js";
import { attachDictationSocket } from "../src/dictationSocket.js";

export async function startLocalServer(port = 4000, opts: LocalProviders = {}) {
  if (!existsSync(join(import.meta.dirname, "../../frontend/dist/index.html"))) {
    throw new Error("Build the frontend first with npm run build from the repository root.");
  }
  const local = await createLocalContext({ ...opts, port });
  const app = buildApp(local.ctx);
  const server = app.listen(port, "127.0.0.1");
  const dictation = attachDictationSocket(server, local.ctx);
  try {
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  } catch (error) {
    dictation.close();
    await local.ctx.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local server address");
  const origin = `http://127.0.0.1:${address.port}`;
  local.ctx.config.PATIENT_APP_URL = origin;
  return { ...local, server, origin, async close() {
    dictation.close();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await local.ctx.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LOCAL_TEST_PORT ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LOCAL_TEST_PORT must be 1–65535");
  const local = await startLocalServer(port);
  console.log(`Local app: ${local.origin}\nDoctor: rivera@demo.health / demo1234\nPatient/caregiver DOB: 2000-01-01; use the link from a completed writeup\nSwagger: ${local.origin}/api/docs/\nSwagger provider key: local-test-key\nAI and speech are labeled fixtures. Emails are captured locally. Restart clears data.`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void local.close().then(() => process.exit(0));
  });
}
