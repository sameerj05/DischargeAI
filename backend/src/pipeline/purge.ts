import { newReceipt, type DeletionReceipt } from "../audit/receipts.js";
import type { AppContext } from "../context.js";
import { logRef } from "../crypto/sumId.js";

export interface PurgeReport {
  ranAt: string;
  linksPurged: number;
  documentsDeleted: number;
  pdfsDeleted: number;
  audioDeleted: number;
  orphanDocumentsDeleted: number;
  purged: { linkRef: string; expiresAt: string; documentDeleted: boolean; pdfDeleted: boolean; audioDeleted: boolean }[];
  receipts: DeletionReceipt[];
}

/**
 * The 30-day self-destruct, in code. For every link past its expiry:
 *   1. delete the summary item (raw text, the agent's response) from the document store,
 *   2. delete the PDF and the audio object from their buckets, one deletion receipt each,
 *   3. mark the link purged,
 *   4. write audit events.
 * Then a backstop: any item past its TTL that the loop above did not reach is deleted with a receipt
 * (DynamoDB's own TTL and the S3 lifecycle rules are the other layers).
 * Read paths check expiry on their own, so a purge that has not run yet never exposes data.
 */
export async function runPurge(ctx: AppContext): Promise<PurgeReport> {
  const { activeLinks, audit, summaries, pdf, audio, receipts, clock, log } = ctx;
  assertDemoPurgeAllowed(ctx);
  const ranAt = clock.nowIso();
  const report: PurgeReport = { ranAt, linksPurged: 0, documentsDeleted: 0, pdfsDeleted: 0, audioDeleted: 0, orphanDocumentsDeleted: 0, purged: [], receipts: [] };
  const record = async (receipt: DeletionReceipt) => {
    await receipts.append(receipt);
    report.receipts.push(receipt);
  };

  const expired = await activeLinks.listExpiredUnpurged(ranAt);
  for (const link of expired) {
    const ref = logRef(link.sumId);
    const expiresAtEpoch = Math.floor(new Date(link.expiresAt).getTime() / 1000);

    const documentDeleted = await summaries.delete(link.sumId);
    if (documentDeleted) await record(newReceipt({ sumId: link.sumId, uid: link.sumId, deleted: "record", mechanism: "purge_job", source: "purge", expiresAt: expiresAtEpoch, at: clock.nowIso() }));
    let pdfDeleted = false;
    if (link.pdfKey) {
      pdfDeleted = await pdf.delete(link.pdfKey);
      if (pdfDeleted) await record(newReceipt({ sumId: link.sumId, key: link.pdfKey, deleted: "pdf", mechanism: "purge_job", source: "purge", at: clock.nowIso() }));
    }
    let audioDeleted = false;
    if (link.audioKey) {
      audioDeleted = await audio.delete(link.audioKey);
      if (audioDeleted) await record(newReceipt({ sumId: link.sumId, key: link.audioKey, deleted: "audio", mechanism: "purge_job", source: "purge", at: clock.nowIso() }));
    }

    await activeLinks.setStatus(link.sumId, "purged");
    await audit.append({ event: "link.purged", sumId: link.sumId, actor: "system", at: clock.nowIso(), details: { documentDeleted, pdfDeleted, audioDeleted, expiresAt: link.expiresAt } });

    report.linksPurged += 1;
    if (documentDeleted) report.documentsDeleted += 1;
    if (pdfDeleted) report.pdfsDeleted += 1;
    if (audioDeleted) report.audioDeleted += 1;
    report.purged.push({ linkRef: ref, expiresAt: link.expiresAt, documentDeleted, pdfDeleted, audioDeleted });
    log.info({ link: ref, documentDeleted, pdfDeleted, audioDeleted }, "link purged");
  }

  // Backstop: any item past its TTL that the loop above did not reach.
  for (const item of await summaries.listExpired(clock.nowEpochSeconds())) {
    if (!(await summaries.delete(item.uid))) continue;
    await record(newReceipt({ sumId: item.uid, uid: item.uid, deleted: "record", mechanism: "purge_job", source: "sweeper", expiresAt: item.expiresAt, at: clock.nowIso() }));
    report.orphanDocumentsDeleted += 1;
  }

  await audit.append({ event: "purge.run", actor: "system", at: clock.nowIso(), details: { linksPurged: report.linksPurged, documentsDeleted: report.documentsDeleted, pdfsDeleted: report.pdfsDeleted, audioDeleted: report.audioDeleted, orphanDocumentsDeleted: report.orphanDocumentsDeleted, receipts: report.receipts.length } });
  return report;
}

/**
 * DEMO_NOW pins the clock ahead so a day-30 demo can run today. The purge would then treat every recent
 * item in the shared DynamoDB table and every object of this backend's links as expired and delete it,
 * so a shifted purge refuses to run unless DEMO_PURGE_ON_AWS=yes says the account is a throwaway.
 * Nothing is deleted when this throws. Read-time expiry (410) still follows the shifted clock.
 */
export function assertDemoPurgeAllowed(ctx: Pick<AppContext, "clock" | "config">): void {
  if (!ctx.clock.demoNow || ctx.config.DEMO_PURGE_ON_AWS === "yes") return;
  throw new Error(
    `Refusing to purge with DEMO_NOW=${ctx.clock.demoNow}: the shifted clock would make recent data in the shared DynamoDB table and S3 buckets look expired and delete it. ` +
      "Set DEMO_PURGE_ON_AWS=yes on a throwaway account to allow it.",
  );
}
