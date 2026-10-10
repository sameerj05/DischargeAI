import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIO_LIFECYCLE_RULE, S3AudioStore } from "../src/audiostore/s3.js";
import { SecureAudio } from "../src/audiostore/secure.js";
import { LocalAudioStore } from "../src/audiostore/local.js";
import { newDataKey } from "../src/crypto/envelope.js";
import { hashLinkId } from "../src/crypto/linkId.js";
import { createTestApp, type TestApp } from "./helpers.js";

const FAKE_WAV = Buffer.from("RIFF....WAVEfmt fake audio bytes: furosemide forty milligrams");

describe("audio store (lane 4: S3 audio bucket / local twin)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("ingest stores the clip sealed with the link key before transcribing, and audits it without PHI", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", list.patients[0].id)
      .attach("audio", FAKE_WAV, { filename: "dictation.wav", contentType: "audio/wav" });
    expect(res.status).toBe(202);
    await t.ctx.queue.onIdle();
    const hash = hashLinkId(res.body.linkId);

    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.meta).toMatchObject({ audioStore: "local", audioKey: `audio/${hash}`, audioBytes: FAKE_WAV.length + 28 });

    const files = readdirSync(t.audioDir);
    expect(files.sort()).toEqual([`${hash}.bin`, `${hash}.json`]);
    const onDisk = readFileSync(join(t.audioDir, `${hash}.bin`));
    expect(onDisk.includes(FAKE_WAV)).toBe(false);
    expect(onDisk.toString("latin1")).not.toContain("furosemide");
    const meta = JSON.parse(readFileSync(join(t.audioDir, `${hash}.json`), "utf8"));
    expect(meta).toMatchObject({ key: `audio/${hash}`, contentType: "audio/wav", keyVersion: 1 });
    expect(meta.expiresAt).toBe(Math.floor(new Date(res.body.expiresAt).getTime() / 1000));
    expect(JSON.stringify(meta)).not.toContain("dictation.wav");

    const link = await t.ctx.links.getByHash(hash);
    const opened = await t.ctx.secureAudio.get({ linkIdHash: hash, key: link!.encKey! });
    expect(opened?.body.equals(FAKE_WAV)).toBe(true);
    await expect(t.ctx.secureAudio.get({ linkIdHash: hash, key: newDataKey() })).rejects.toThrow();

    const audit = await t.provider(request(t.app).get(`/audit?link=${res.body.linkId}`));
    const stored = audit.body.events.find((e: { event: string }) => e.event === "audio.stored");
    expect(stored.details).toMatchObject({ store: "local", key: `audio/${hash}`, sealed: true });
    expect(JSON.stringify(audit.body)).not.toContain("dictation.wav");
  });

  it("a job that restarts after the clip was stored resumes from the store", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", list.patients[3].id)
      .attach("audio", FAKE_WAV, { filename: "a.wav", contentType: "audio/wav" });
    await t.ctx.queue.onIdle();
    const hash = hashLinkId(res.body.linkId);
    // Simulate "process died after storing the clip": drop the derived documents and re-run with no pending input.
    await t.ctx.docStore.deleteAll(`link#${hash}`);
    await t.ctx.jobs.setStage(res.body.jobId, "transcribing", t.ctx.clock.nowIso());
    await t.ctx.links.setStatus(hash, "pending");
    const { runIngestJob } = await import("../src/pipeline/ingestJob.js");
    await runIngestJob(t.ctx, res.body.jobId);
    const job = await t.ctx.jobs.get(res.body.jobId);
    expect(job?.stage).toBe("done");
    const summary = await request(t.app).get(`/summary?link=${res.body.linkId}`);
    expect(summary.status).toBe(200);
    expect(summary.body.medications.new.some((m: { name: string }) => m.name === "Furosemide")).toBe(true);
  });

  it("day 30: purge deletes the audio object and writes a deletion receipt for it, the key and every record", async () => {
    const { body: list } = await t.provider(request(t.app).get("/patients"));
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", list.patients[4].id)
      .attach("audio", FAKE_WAV, { filename: "b.wav", contentType: "audio/wav" });
    await t.ctx.queue.onIdle();
    const hash = hashLinkId(res.body.linkId);
    expect(existsSync(join(t.audioDir, `${hash}.bin`))).toBe(true);

    await t.provider(request(t.app).post("/admin/clock/advance")).send({ days: 30 });
    const purge = await t.provider(request(t.app).post("/admin/purge"));
    expect(purge.status).toBe(200);
    expect(purge.body.audioDeleted).toBeGreaterThanOrEqual(1);
    expect(purge.body.receipts.some((r: { event: string; what: string }) => r.event === "audio.deleted" && r.what === `local:audio/${hash}`)).toBe(true);
    expect(existsSync(join(t.audioDir, `${hash}.bin`))).toBe(false);
    expect(existsSync(join(t.audioDir, `${hash}.json`))).toBe(false);

    const audit = await t.provider(request(t.app).get(`/audit?link=${res.body.linkId}`));
    const receipts = audit.body.deletionReceipts as { event: string; details: Record<string, unknown> }[];
    expect(receipts.map((r) => r.event).sort()).toEqual(["audio.deleted", "key.destroyed", "record.deleted", "record.deleted"]);
    expect(receipts.find((r) => r.event === "audio.deleted")!.details).toMatchObject({ store: "local", key: `audio/${hash}`, job: "purge", receipt: true, reason: "expired" });
    expect(receipts.filter((r) => r.event === "record.deleted").map((r) => r.details.sk).sort()).toEqual(["raw", "simplified"]);
    expect(receipts.every((r) => r.details.table === "discharge_records" || r.event !== "record.deleted")).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain("Furosemide");

    const all = await t.provider(request(t.app).get("/audit/receipts"));
    expect(all.body.count).toBeGreaterThanOrEqual(4);
    await t.provider(request(t.app).post("/admin/clock/reset"));
  });

  it("the backstop sweep removes an expired clip whose link row is already gone", async () => {
    const store = new LocalAudioStore(t.audioDir);
    const orphan = "f".repeat(64);
    await store.put({ linkIdHash: orphan, body: Buffer.from("x"), contentType: "audio/wav", keyVersion: 1, expiresAt: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    expect((await store.listExpired(2)).map((e) => e.linkIdHash)).toEqual([orphan]);
    const purge = await t.provider(request(t.app).post("/admin/purge"));
    expect(purge.body.orphanAudioDeleted).toBe(1);
    expect(await store.head(orphan)).toBeNull();
  });
});

describe("S3 audio store (client stubbed; no bucket in this container)", () => {
  it("puts under audio/<linkIdHash> with SSE and metadata, heads, gets and deletes", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const objects = new Map<string, { Body: Buffer; Metadata: Record<string, string> }>();
    const client = {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        const key = String(cmd.input.Key);
        switch (cmd.constructor.name) {
          case "PutObjectCommand":
            objects.set(key, { Body: cmd.input.Body as Buffer, Metadata: cmd.input.Metadata as Record<string, string> });
            return {};
          case "HeadObjectCommand": {
            const o = objects.get(key);
            if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
            return { ContentLength: o.Body.length, Metadata: o.Metadata };
          }
          case "GetObjectCommand": {
            const o = objects.get(key)!;
            return { Body: { transformToByteArray: async () => new Uint8Array(o.Body) } };
          }
          case "DeleteObjectCommand":
            objects.delete(key);
            return {};
          default:
            throw new Error(`unexpected ${cmd.constructor.name}`);
        }
      },
    };
    const store = new S3AudioStore({ bucket: "dischargeai-audio", region: "us-west-2", client: client as never });
    const secure = new SecureAudio(store);
    const key = newDataKey();
    const hash = "a".repeat(64);
    const meta = await secure.put({ linkIdHash: hash, key, keyVersion: 1, body: FAKE_WAV, contentType: "audio/wav", expiresAt: 1_900_000_000, createdAt: "2026-10-10T00:00:00.000Z" });
    expect(meta.key).toBe(`audio/${hash}`);
    const put = sent.find((s) => s.name === "PutObjectCommand")!.input;
    expect(put).toMatchObject({ Bucket: "dischargeai-audio", Key: `audio/${hash}`, ServerSideEncryption: "AES256", ContentType: "application/octet-stream", Tagging: "expiresAt=1900000000" });
    expect((put.Metadata as Record<string, string>)["clip-content-type"]).toBe("audio/wav");
    expect((put.Body as Buffer).includes(FAKE_WAV)).toBe(false);

    expect(await store.head(hash)).toMatchObject({ key: `audio/${hash}`, contentType: "audio/wav", expiresAt: 1_900_000_000, keyVersion: 1 });
    const opened = await secure.get({ linkIdHash: hash, key });
    expect(opened?.body.equals(FAKE_WAV)).toBe(true);
    expect(await store.delete(hash)).toMatchObject({ key: `audio/${hash}` });
    expect(await store.head(hash)).toBeNull();
    expect(await store.delete(hash)).toBeNull();
  });

  it("the lifecycle rule expires audio/ objects after 30 days", () => {
    expect(AUDIO_LIFECYCLE_RULE).toMatchObject({ Status: "Enabled", Filter: { Prefix: "audio/" }, Expiration: { Days: 30 } });
  });
});
