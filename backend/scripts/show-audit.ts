/**
 * Prints the audit log: the event trail of one summary, the deletion receipts, or the latest events.
 *   npm run show-audit -- --link <sumId>      everything that happened to one summary id
 *   npm run show-audit -- --receipts          deletion receipts only (what was deleted, when, by which mechanism)
 *   npm run show-audit                        the latest 200 events
 * Nothing printed here is PHI: the audit log stores ids, stages, counts and mechanisms only.
 */
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { createContext } from "../src/context.js";
import { isSumIdShaped } from "../src/crypto/sumId.js";
import type { AuditEntry } from "../src/db/repos/audit.js";
import { createLogger } from "../src/logger.js";

const args = process.argv.slice(2);
const linkArg = args.includes("--link") ? args[args.indexOf("--link") + 1] : undefined;
const receiptsOnly = args.includes("--receipts");
const asJson = args.includes("--json");

const { env, secrets } = await loadRuntimeEnv({ log: createLogger("silent") });
const ctx = await createContext({
  env: { ...env, EMAIL_TRANSPORT: "console", EMAIL_QUEUE: "none", PURGE_INTERVAL_MS: "0", LOG_LEVEL: "silent" },
  secrets,
  resumeJobs: false,
});

let entries: AuditEntry[];
let heading: string;
if (linkArg) {
  if (!isSumIdShaped(linkArg)) {
    console.error("--link expects the 43-character sumId");
    process.exit(2);
  }
  entries = await ctx.audit.listForLink(linkArg);
  const link = await ctx.activeLinks.getBySumId(linkArg);
  heading = `summary ${linkArg}: status=${link?.status ?? "unknown"} expiresAt=${link?.expiresAt ?? "?"}`;
} else if (receiptsOnly) {
  const receipts = await ctx.receipts.list();
  await ctx.close();
  console.log(asJson ? JSON.stringify({ sink: ctx.receipts.name, receipts }, null, 2) : `deletion receipts (${receipts.length}) from the ${ctx.receipts.name} sink`);
  if (!asJson) for (const r of receipts) console.log(`  ${r.at}  ${r.deleted.padEnd(7)}  ${r.mechanism.padEnd(14)}  ${r.sumId.padEnd(22)}  ${r.uid ?? r.key ?? ""}${r.expiresAt ? `  expiresAt=${r.expiresAt}` : ""}`);
  process.exit(0);
} else {
  entries = await ctx.audit.listRecent(200);
  heading = `latest ${entries.length} events`;
}
await ctx.close();

if (asJson) {
  console.log(JSON.stringify({ heading, entries }, null, 2));
} else {
  console.log(heading);
  for (const e of entries) {
    console.log(`  ${e.at}  ${e.actor.padEnd(8)}  ${e.event.padEnd(20)}  ${e.sumId ? e.sumId : "-".padEnd(22)}  ${JSON.stringify(e.details)}`);
  }
}
