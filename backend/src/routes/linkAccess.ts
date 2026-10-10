import type { StoredSummary } from "../agents/types.js";
import type { AppContext } from "../context.js";
import { hashLinkId, isLinkIdShaped } from "../crypto/linkId.js";
import type { LinkRecord } from "../db/repos/links.js";
import { SK } from "../docstore/types.js";
import { badRequest, gone, notFound, tooEarly } from "../errors.js";

export interface LinkAccess {
  linkIdHash: string;
  link: LinkRecord;
  stored: StoredSummary;
  expiresAt: string;
  daysLeft: number;
}

/**
 * Every patient endpoint goes through here. Order matters:
 *   400 malformed id -> 404 unknown -> 410 purged / expired (checked against the app clock at read
 *   time, independently of the purge job) -> 425 still processing -> 500 failed -> decrypt and return.
 * A link that is found expired here is marked expired and audited immediately; the purge job will
 * shred its key on its next run.
 */
export async function resolveLink(ctx: AppContext, linkParam: unknown): Promise<LinkAccess> {
  if (!isLinkIdShaped(linkParam)) throw badRequest("invalid_link", "link must be the 22-character token from your email");
  const linkIdHash = hashLinkId(linkParam);
  const link = await ctx.links.getByHash(linkIdHash);
  if (!link) throw notFound("link_not_found", "No discharge summary exists for this link");

  const now = ctx.clock.now();
  const expiresAt = new Date(link.expiresAt);
  if (link.status === "purged") {
    throw gone("link_purged", "This discharge summary was permanently deleted after 30 days", { expiresAt: link.expiresAt });
  }
  if (link.status === "expired" || expiresAt.getTime() <= now.getTime() || !link.encKey) {
    if (link.status !== "expired") {
      await ctx.links.setStatus(linkIdHash, "expired");
      await ctx.audit.append({ event: "link.expired", linkIdHash, actor: "system", at: ctx.clock.nowIso(), details: { detectedAt: "read" } });
    }
    throw gone("link_expired", "This discharge summary expired 30 days after it was created", { expiresAt: link.expiresAt });
  }

  const job = await ctx.jobs.latestForLink(linkIdHash);
  if (link.status === "pending" || (job && !["done", "needs_review", "failed"].includes(job.stage))) {
    throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "received", jobId: job?.id });
  }
  if (link.status === "failed" || job?.stage === "failed") {
    throw Object.assign(new Error("processing_failed"), { status: 500 });
  }

  const stored = await ctx.secureDocs.getJson<StoredSummary>({ linkIdHash, sk: SK.simplified, key: link.encKey });
  if (!stored) throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "stored" });

  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
  return { linkIdHash, link, stored, expiresAt: link.expiresAt, daysLeft };
}
