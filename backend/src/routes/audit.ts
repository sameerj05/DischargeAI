import { Router } from "express";
import type { AppContext } from "../context.js";
import { hashLinkId, isLinkIdShaped } from "../crypto/linkId.js";
import { DELETION_RECEIPT_EVENTS } from "../db/repos/audit.js";
import { badRequest } from "../errors.js";

/**
 * GET /audit?link=<linkId> (provider): the event trail for a link, with its deletion receipts
 * (key destroyed, each discharge_records item deleted, the audio object deleted) pulled out so the
 * day-30 proof is one field. GET /audit/receipts (provider): every receipt in the log. Never PHI.
 */
export function auditRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/audit", async (req, res) => {
    const link = req.query.link;
    if (!isLinkIdShaped(link)) throw badRequest("invalid_link", "link must be a 22-character link id");
    const linkIdHash = hashLinkId(link);
    const events = await ctx.audit.listForLink(linkIdHash);
    const record = await ctx.links.getByHash(linkIdHash);
    res.json({
      linkIdHash,
      link: record
        ? { status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt, keyDestroyed: record.encKey === null, lastViewedAt: record.lastViewedAt, languages: record.languages }
        : null,
      events,
      deletionReceipts: events.filter((e) => DELETION_RECEIPT_EVENTS.has(e.event)),
    });
  });
  r.get("/audit/receipts", async (_req, res) => {
    const receipts = await ctx.audit.listDeletionReceipts();
    res.json({ count: receipts.length, receipts });
  });
  return r;
}
