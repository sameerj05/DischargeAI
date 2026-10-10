import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashLinkId } from "../src/crypto/linkId.js";
import { aadFor, open } from "../src/crypto/envelope.js";
import { uidFor } from "../src/docstore/types.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("30-day expiry and purge", () => {
  let t: TestApp;
  let linkId: string;
  let patientId: string;
  beforeAll(async () => {
    t = await createTestApp();
    ({ linkId, patientId } = await ingestText(t, exampleText("example-1-chf")));
    await request(t.app).get(`/translate?link=${linkId}&language=es`);
  });
  afterAll(() => t.close());

  it("serves the summary on day 29 and returns 410 on day 30 without any purge having run", async () => {
    const ok = await request(t.app).get(`/summary?link=${linkId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.daysLeft).toBe(30);

    await t.provider(request(t.app).post("/admin/clock/advance")).send({ days: 29 });
    const day29 = await request(t.app).get(`/summary?link=${linkId}`);
    expect(day29.status).toBe(200);
    expect(day29.body.daysLeft).toBe(1);

    await t.provider(request(t.app).post("/admin/clock/advance")).send({ days: 1 });
    const day30 = await request(t.app).get(`/summary?link=${linkId}`);
    expect(day30.status).toBe(410);
    expect(day30.body.error).toBe("link_expired");
    const translate = await request(t.app).get(`/translate?link=${linkId}&language=es`);
    expect(translate.status).toBe(410);
    const checklist = await request(t.app).post("/checklist/complete").send({ link: linkId, itemId: "med-1", completed: true });
    expect(checklist.status).toBe(410);
  });

  it("purge destroys the key, deletes every document, marks the link purged and clears the patient's active link", async () => {
    const hash = hashLinkId(linkId);
    const before = await t.ctx.links.getByHash(hash);
    expect(before?.encKey).not.toBeNull();
    const docsBefore = await t.ctx.docStore.list(uidFor(hash));
    expect(docsBefore.map((d) => d.doc).sort()).toEqual(["raw", "simplified", "translation#es"]);
    const keptCiphertext = docsBefore.find((d) => d.doc === "simplified")!;
    const keptKey = Buffer.from(before!.encKey!);

    const res = await t.provider(request(t.app).post("/admin/purge"));
    expect(res.status).toBe(200);
    expect(res.body.linksPurged).toBe(1);
    expect(res.body.documentsDeleted).toBe(3);
    expect(res.body.keysDestroyed).toBe(1);
    expect(res.body.audioDeleted).toBe(0);
    expect(res.body.receipts.map((r: { event: string }) => r.event)).toEqual(["key.destroyed", "record.deleted", "record.deleted", "record.deleted"]);

    const after = await t.ctx.links.getByHash(hash);
    expect(after?.status).toBe("purged");
    expect(after?.encKey).toBeNull();
    expect(await t.ctx.docStore.list(uidFor(hash))).toEqual([]);
    const patient = await t.ctx.patients.getById(patientId);
    expect(patient?.activeLinkId).toBeNull();

    // The only copy of the key is gone; the ciphertext we kept is unreadable with anything the system still holds.
    expect(() => open(Buffer.alloc(32), keptCiphertext, aadFor(uidFor(hash), "simplified", 1))).toThrow();
    // (and only the destroyed key could ever have opened it)
    expect(open(keptKey, keptCiphertext, aadFor(uidFor(hash), "simplified", 1)).length).toBeGreaterThan(0);

    const gone = await request(t.app).get(`/summary?link=${linkId}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe("link_purged");

    const audit = await t.provider(request(t.app).get(`/audit?link=${linkId}`));
    const events = audit.body.events.map((e: { event: string }) => e.event);
    expect(events).toContain("link.expired");
    expect(events).toContain("key.destroyed");
    expect(events).toContain("link.purged");
    expect(audit.body.link.keyDestroyed).toBe(true);
    // Deletion receipts: the key, then one per document on the discharge-summaries item, each naming what and by which job.
    const receipts = audit.body.deletionReceipts as { event: string; details: Record<string, unknown> }[];
    expect(receipts.map((r) => r.event)).toEqual(["key.destroyed", "record.deleted", "record.deleted", "record.deleted"]);
    expect(receipts.slice(1).map((r) => r.details.doc)).toEqual(["raw", "simplified", "translation#es"]);
    expect(receipts.slice(1).every((r) => r.details.uid === uidFor(hash))).toBe(true);
    expect(receipts.slice(1).every((r) => r.details.table === "discharge_summaries" && r.details.job === "purge" && r.details.receipt === true)).toBe(true);
    expect(receipts[0].details).toMatchObject({ keyVersion: 1, job: "purge", reason: "expired" });
  });

  it("purge is idempotent and leaves unexpired links alone", async () => {
    const fresh = await ingestText(t, exampleText("example-3-hfpef-cellulitis"));
    const res = await t.provider(request(t.app).post("/admin/purge"));
    expect(res.body.linksPurged).toBe(0);
    const ok = await request(t.app).get(`/summary?link=${fresh.linkId}`);
    expect(ok.status).toBe(200);
  });
});
