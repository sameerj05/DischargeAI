import type { AppContext } from "../context.js";
import { isSumIdShaped } from "../crypto/sumId.js";
import type { ActiveLink, LinkStatus } from "../db/repos/activeLinks.js";
import type { SummaryItem } from "../docstore/types.js";
import { AppError, badRequest, gone, notFound, tooEarly } from "../errors.js";

export interface SummaryAccess {
  sumId: string;
  /** The SQL activeLinks row, when there is one. An item written straight into DynamoDB has none. */
  link?: ActiveLink;
  item: SummaryItem;
  /** The agent's response, as it came back. */
  llmSummary: unknown;
  expiresAt: string;
  daysLeft: number;
}

/** The summary id from any of the spellings the routes accept: sum-id (contract), sum_id (contract), sumId, link, token. */
export function sumIdFromQuery(query: Record<string, unknown>): unknown {
  for (const key of ["sum-id", "sum_id", "sumId", "link", "token"]) {
    const v = query[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

const ITEM_STATUS_TO_LINK: Record<SummaryItem["status"], LinkStatus> = { processing: "pending", ready: "ready", failed: "failed" };

/**
 * Every patient read goes through here. The DynamoDB item is the source of truth, as the tasks doc
 * has it ("gets llm generated summary based on the summary id from the dynamodb table"); the SQL
 * activeLinks row is consulted too when there is one, and wins for status and expiry because the
 * purge job and the ingest job keep it current. An item written straight into the table has no row
 * and is judged by its own `status` and `expiresAt`.
 * Order: 400 malformed id -> 404 neither a link nor an item -> 410 purged / expired (checked against
 * the app clock at read time, independently of the purge job and of DynamoDB's lazy TTL) -> 425 the
 * agent is still working -> 500 the agent run failed -> the item with its llm-summary.
 */
export async function resolveSummary(ctx: AppContext, sumIdParam: unknown): Promise<SummaryAccess> {
  if (!isSumIdShaped(sumIdParam)) throw badRequest("invalid_link", "sum-id must be the 43-character id from the link (sum-id, sum_id or link)");
  const sumId = sumIdParam;
  const link = await ctx.activeLinks.getBySumId(sumId);
  const item = await ctx.summaries.get(sumId);
  if (!link && !item) throw notFound("link_not_found", "No discharge summary exists for this id");

  const status: LinkStatus = link ? link.status : ITEM_STATUS_TO_LINK[item!.status] ?? "pending";
  const expiresIso = link ? link.expiresAt : new Date(item!.expiresAt * 1000).toISOString();
  const now = ctx.clock.now();
  const expiresAt = new Date(expiresIso);
  if (status === "purged") {
    throw gone("link_purged", "This discharge summary was permanently deleted 30 days after it was created", { expiresAt: expiresIso });
  }
  if (status === "expired" || expiresAt.getTime() <= now.getTime()) {
    if (link && status !== "expired") {
      await ctx.activeLinks.setStatus(sumId, "expired");
      await ctx.audit.append({ event: "link.expired", sumId, actor: "system", at: ctx.clock.nowIso(), details: { detectedAt: "read" } });
    }
    throw gone("link_expired", "This discharge summary expired 30 days after it was created", { expiresAt: expiresIso });
  }

  const job = link ? await ctx.jobs.latestForLink(sumId) : undefined;
  if (status === "pending" || (job && !["done", "needs_review", "failed"].includes(job.stage) && status !== "ready")) {
    throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "received", jobId: job?.id, expiresAt: expiresIso });
  }
  if (status === "failed") {
    throw new AppError(500, "processing_failed", "The summary could not be prepared", { expiresAt: expiresIso });
  }

  const llmSummary = item?.["llm-summary"];
  if (!item || llmSummary === undefined) throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "stored", expiresAt: expiresIso });

  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
  return { sumId, link, item, llmSummary, expiresAt: expiresIso, daysLeft };
}

/** The body every summary read returns: the agent's response untouched, plus the link facts. */
export async function summaryBody(ctx: AppContext, access: SummaryAccess, route: string) {
  const at = ctx.clock.nowIso();
  await ctx.activeLinks.touchViewed(access.sumId, at);
  await ctx.audit.append({ event: "summary.viewed", sumId: access.sumId, actor: "patient", at, details: { daysLeft: access.daysLeft, route } });
  return {
    "sum-id": access.sumId,
    sumId: access.sumId,
    patientID: access.item.patientID,
    status: access.item.status,
    "llm-summary": access.llmSummary,
    createdAt: access.item.createdAt,
    expiresAt: access.expiresAt,
    daysLeft: access.daysLeft,
  };
}
