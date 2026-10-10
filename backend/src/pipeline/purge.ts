import type { AppContext } from "../context.js";
import { hashLinkId, hashPrefix } from "../crypto/linkId.js";
import { linkIdHashFromAudioKey } from "../audiostore/types.js";

export interface PurgeReport {
  ranAt: string;
  linksPurged: number;
  documentsDeleted: number;
  audioDeleted: number;
  keysDestroyed: number;
  orphanDocumentsDeleted: number;
  orphanAudioDeleted: number;
  /** One line per deletion receipt written to the audit log during this run. */
  receipts: { event: "key.destroyed" | "record.deleted" | "audio.deleted"; linkRef: string; what: string }[];
  purged: { linkIdHashPrefix: string; expiresAt: string; documentsDeleted: number; audioDeleted: boolean }[];
}

/**
 * The 30-day self-destruct, in code. For every link past its expiry:
 *   1. destroy the data key (crypto-shredding: anything still stored is unreadable from this moment),
 *   2. delete every discharge_records item for the link, one receipt each,
 *   3. delete the audio object (S3 or local), one receipt,
 *   4. mark the link purged, clear the patient's active link, drop the checklist state,
 *   5. write link.purged and purge.run.
 * Every receipt names what was deleted (table or bucket, key, sk), when, and the job that did it,
 * and never contains PHI. Read paths check expiry on their own, so a purge that has not run yet
 * never exposes data. DynamoDB TTL on `expiresAt` and the S3 lifecycle rule are backstops.
 */
export async function runPurge(ctx: AppContext): Promise<PurgeReport> {
  const { links, patients, audit, docStore, audioStore, checklist, clock, log } = ctx;
  const ranAt = clock.nowIso();
  const report: PurgeReport = { ranAt, linksPurged: 0, documentsDeleted: 0, audioDeleted: 0, keysDestroyed: 0, orphanDocumentsDeleted: 0, orphanAudioDeleted: 0, receipts: [], purged: [] };
  const receipt = async (event: PurgeReport["receipts"][number]["event"], linkIdHash: string, details: Record<string, unknown>, what: string) => {
    await audit.append({ event, linkIdHash, actor: "system", at: clock.nowIso(), details: { ...details, job: details.job ?? "purge", receipt: true } });
    report.receipts.push({ event, linkRef: hashPrefix(linkIdHash), what });
  };

  const expired = await links.listExpiredUnpurged(ranAt);
  for (const link of expired) {
    const prefix = hashPrefix(link.linkIdHash);
    const pk = `link#${link.linkIdHash}`;

    if (link.encKey) {
      await links.destroyKey(link.linkIdHash);
      report.keysDestroyed += 1;
      await receipt("key.destroyed", link.linkIdHash, { keyVersion: link.keyVersion, reason: "expired", expiresAt: link.expiresAt }, `data key v${link.keyVersion}`);
    }

    let deleted = 0;
    for (const item of await docStore.list(pk)) {
      await docStore.delete(pk, item.sk);
      deleted += 1;
      await receipt("record.deleted", link.linkIdHash, { store: docStore.name, table: docStore.tableName, sk: item.sk, expiresAt: item.expiresAt, reason: "expired" }, `${docStore.tableName}/${item.sk}`);
    }

    const audio = await audioStore.delete(link.linkIdHash);
    if (audio) {
      report.audioDeleted += 1;
      await receipt("audio.deleted", link.linkIdHash, { store: audioStore.name, location: audioStore.location, key: audio.key, bytes: audio.bytes, expiresAt: audio.expiresAt, reason: "expired" }, `${audioStore.name}:${audio.key}`);
    }

    await links.setStatus(link.linkIdHash, "purged");
    const patient = await patients.getById(link.patientId);
    if (patient?.activeLinkId && hashLinkId(patient.activeLinkId) === link.linkIdHash) {
      await patients.clearActiveLink(patient.id, patient.activeLinkId);
    }
    await checklist.deleteForLink(link.linkIdHash);
    await audit.append({ event: "link.purged", linkIdHash: link.linkIdHash, actor: "system", at: clock.nowIso(), details: { documentsDeleted: deleted, audioDeleted: !!audio, keyDestroyed: true, expiresAt: link.expiresAt, job: "purge" } });

    report.linksPurged += 1;
    report.documentsDeleted += deleted;
    report.purged.push({ linkIdHashPrefix: prefix, expiresAt: link.expiresAt, documentsDeleted: deleted, audioDeleted: !!audio });
    log.info({ link: prefix, documentsDeleted: deleted, audioDeleted: !!audio }, "link purged");
  }

  // Backstop sweeps: anything past its TTL that the loop above did not reach (DynamoDB TTL and the
  // S3 lifecycle do the same on AWS, with a lag; here it is exact).
  const now = clock.nowEpochSeconds();
  for (const item of await docStore.listExpired(now)) {
    await docStore.delete(item.pk, item.sk);
    report.orphanDocumentsDeleted += 1;
    await receipt("record.deleted", item.pk.replace(/^link#/, ""), { store: docStore.name, table: docStore.tableName, sk: item.sk, reason: "ttl_backstop", job: "purge.backstop" }, `${docStore.tableName}/${item.sk}`);
  }
  for (const { linkIdHash, meta } of await audioStore.listExpired(now)) {
    await audioStore.delete(linkIdHash);
    report.orphanAudioDeleted += 1;
    await receipt("audio.deleted", linkIdHashFromAudioKey(meta.key), { store: audioStore.name, location: audioStore.location, key: meta.key, bytes: meta.bytes, expiresAt: meta.expiresAt, reason: "ttl_backstop", job: "purge.backstop" }, `${audioStore.name}:${meta.key}`);
  }

  await audit.append({
    event: "purge.run",
    actor: "system",
    at: clock.nowIso(),
    details: {
      linksPurged: report.linksPurged,
      keysDestroyed: report.keysDestroyed,
      documentsDeleted: report.documentsDeleted,
      audioDeleted: report.audioDeleted,
      orphanDocumentsDeleted: report.orphanDocumentsDeleted,
      orphanAudioDeleted: report.orphanAudioDeleted,
      receipts: report.receipts.length,
    },
  });
  return report;
}
