import type { PipelineResult } from "../agents/pipeline.js";
import type { StoredSummary, StoredTranslation } from "../agents/types.js";
import type { AppContext } from "../context.js";
import { hashPrefix } from "../crypto/linkId.js";
import type { JobStage } from "../db/repos/jobs.js";
import type { LinkRecord } from "../db/repos/links.js";
import { DOC } from "../docstore/types.js";
import { caregiverLinkEmail, patientLinkEmail } from "../email/templates.js";
import { extractPdfText } from "../extract/pdf.js";
import { normalizeText } from "../extract/text.js";

/** What POST /ingest hands to the pipeline. Kept in memory until the `raw` document exists. */
export interface PendingInput {
  /** Raw link id, needed only to build the patient URL for the email. */
  linkId: string;
  kind: "text" | "pdf" | "audio";
  text?: string;
  file?: { buffer: Buffer; mimeType: string; fileName?: string };
}

export interface RawDocument {
  text: string;
  kind: "text" | "pdf" | "audio";
  /** The raw link id is stored encrypted next to the text so a resumed job can still build the URL. */
  linkId: string;
}

export function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * The stage machine:
 *   received -> extracting (pdf) | transcribing (audio) -> simplifying -> checking -> translating
 *            -> stored -> emailing -> done | needs_review
 *   any stage --error--> failed
 * Everything between the clinician text and the per-language JSON is the lane-3 pipeline
 * (src/agents/pipeline.ts); this job persists its input, stores its output, and emails the link.
 */
export async function runIngestJob(ctx: AppContext, jobId: string, pending?: PendingInput): Promise<void> {
  const { jobs, links, patients, audit, secureDocs, clock, log } = ctx;
  const job = await jobs.get(jobId);
  if (!job) return;
  const link = await links.getByHash(job.linkIdHash);
  if (!link) {
    await jobs.setStage(jobId, "failed", clock.nowIso(), "link_missing");
    return;
  }
  const lp = hashPrefix(job.linkIdHash);
  const setStage = async (stage: JobStage, error?: string, detail?: Record<string, unknown>) => {
    await jobs.setStage(jobId, stage, clock.nowIso(), error);
    await audit.append({ event: "job.stage", linkIdHash: job.linkIdHash, actor: "system", at: clock.nowIso(), details: { jobId, stage, ...(detail ?? {}), ...(error ? { error } : {}) } });
    log.info({ jobId, link: lp, stage }, "job stage");
  };

  try {
    if (!link.encKey) throw new Error("link key is gone; cannot process");
    const key = link.encKey;
    const expiresAtEpoch = epochSeconds(link.expiresAt);

    // 1. Get the clinician text: from memory, from the stored raw document, or (audio) from the
    //    stored clip (restart paths).
    let raw: RawDocument | null = await secureDocs.getJson<RawDocument>({ linkIdHash: job.linkIdHash, doc: DOC.raw, key }).catch(() => null);
    if (!raw) {
      let text: string;
      let kind: RawDocument["kind"];
      if (pending?.kind === "text") {
        kind = "text";
        text = normalizeText(pending.text ?? "");
      } else if (pending?.kind === "pdf") {
        kind = "pdf";
        await setStage("extracting");
        const r = await extractPdfText(pending.file!.buffer);
        await jobs.mergeMeta(jobId, { pdfPages: r.pages, pdfEngine: r.engine }, clock.nowIso());
        text = r.text;
      } else if (pending?.kind === "audio" || job.inputKind === "audio") {
        kind = "audio";
        // The clip is persisted first (sealed with the link key, expiresAt = the link's), so a
        // restart resumes from the store and the diagram's "stores audio" box is real.
        let clip: { buffer: Buffer; mimeType: string; fileName?: string };
        if (pending?.file) {
          clip = pending.file;
          const stored = await ctx.secureAudio.put({ linkIdHash: job.linkIdHash, key, keyVersion: link.keyVersion, body: clip.buffer, contentType: clip.mimeType, expiresAt: expiresAtEpoch, createdAt: clock.nowIso() });
          await audit.append({ event: "audio.stored", linkIdHash: job.linkIdHash, actor: "system", at: clock.nowIso(), details: { store: ctx.audioStore.name, location: ctx.audioStore.location, key: stored.key, bytes: stored.bytes, contentType: stored.contentType, expiresAt: stored.expiresAt, sealed: true } });
          await jobs.mergeMeta(jobId, { audioStore: ctx.audioStore.name, audioKey: stored.key, audioBytes: stored.bytes }, clock.nowIso());
        } else {
          const stored = await ctx.secureAudio.get({ linkIdHash: job.linkIdHash, key });
          if (!stored) throw new Error("restart_before_extraction: the input was lost when the process restarted");
          clip = { buffer: stored.body, mimeType: stored.meta.contentType };
        }
        await setStage("transcribing");
        const r = await ctx.pipeline.stages.transcribe.run({ audio: clip.buffer, mimeType: clip.mimeType, fileName: clip.fileName });
        await jobs.mergeMeta(jobId, { transcribeProvider: r.provider, transcribeJobName: r.jobName, transcribeMs: r.latencyMs }, clock.nowIso());
        text = normalizeText(r.text);
      } else {
        throw new Error("restart_before_extraction: the input was lost when the process restarted");
      }
      if (!text) throw new Error("empty_input_after_extraction");
      const linkId = pending?.linkId ?? (await patients.getById(link.patientId))?.activeLinkId ?? "";
      if (!linkId) throw new Error("restart_before_extraction: the link id is not recoverable");
      raw = { text, kind, linkId };
      await secureDocs.putJson({ linkIdHash: job.linkIdHash, doc: DOC.raw, key, keyVersion: link.keyVersion, value: raw, expiresAtEpochSeconds: expiresAtEpoch, createdAt: clock.nowIso() });
    }
    const { text, linkId } = raw;

    // 2. Lane 3: simplify -> safety check -> translate the picked languages.
    const result = await ctx.pipeline.run({
      rawText: text,
      languages: synthesisLanguages(link),
      preferredLanguage: link.language ?? undefined,
      onStage: (stage, detail) => setStage(stage, undefined, detail),
    });
    await jobs.mergeMeta(jobId, { provider: result.meta.provider, model: result.meta.model, usage: result.meta.usage, llmMs: result.meta.latencyMs, fixture: result.meta.fixture, sourceChars: text.length, stages: result.meta.stages, languages: result.meta.languages, fidelity: result.meta.safetyChecks.fidelity }, clock.nowIso());
    await jobs.setWarnings(jobId, result.meta.safetyChecks.warnings, clock.nowIso());

    // 3. Store the encrypted results and activate the link.
    await storePipelineResult(ctx, link, result, { inputKind: job.inputKind, synthesisCount: 1 });
    const finalStage: JobStage = result.meta.safetyChecks.fidelity === "failed" ? "needs_review" : "done";
    await links.setStatus(job.linkIdHash, finalStage === "done" ? "ready" : "needs_review");
    await patients.setActiveLink(link.patientId, linkId, link.expiresAt);
    await setStage("stored", undefined, { languages: result.meta.languages });

    // 4. Email the patient (and the caregiver only with the patient's approval).
    await setStage("emailing");
    const patient = await patients.getById(link.patientId);
    const url = ctx.patientUrl(linkId);
    if (patient) {
      await deliver(ctx, job.linkIdHash, "patient", patientLinkEmail({ to: patient.email, link: url, expiresAt: link.expiresAt }));
    }
    if (link.caregiverEmail && link.caregiverApproved) {
      await deliver(ctx, job.linkIdHash, "caregiver", caregiverLinkEmail({ to: link.caregiverEmail, link: url, expiresAt: link.expiresAt }));
    } else if (link.caregiverEmail && !link.caregiverApproved) {
      await audit.append({ event: "email.queued", linkIdHash: job.linkIdHash, actor: "system", at: clock.nowIso(), details: { kind: "caregiver", skipped: "awaiting_patient_approval" } });
    }

    await setStage(finalStage);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log.error({ jobId, link: lp, err: { name: (err as Error)?.name, message } }, "job failed");
    await jobs.setStage(jobId, "failed", clock.nowIso(), message.slice(0, 500));
    await links.setStatus(job.linkIdHash, "failed").catch(() => undefined);
    await audit.append({ event: "job.stage", linkIdHash: job.linkIdHash, actor: "system", at: clock.nowIso(), details: { jobId, stage: "failed", error: message.slice(0, 200) } });
  }
}

/**
 * Languages translated at synthesis so the toggle is instant for them: the patient's preferred
 * language plus every language the provider picked at ingest (besides en). Any other language is
 * translated lazily on first request.
 */
export function synthesisLanguages(link: Pick<LinkRecord, "language" | "languages">): string[] {
  const out: string[] = [];
  for (const code of [link.language ?? "", ...link.languages]) {
    if (code && code !== "en" && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Writes `simplified` and one `translation#<lang>` per translated language, each encrypted with
 * the link key and carrying the link's expiresAt (the DynamoDB TTL attribute).
 */
export async function storePipelineResult(
  ctx: AppContext,
  link: LinkRecord,
  result: PipelineResult,
  opts: { inputKind: StoredSummary["inputKind"]; synthesisCount: number },
): Promise<{ documents: string[] }> {
  if (!link.encKey) throw new Error("link key is gone; cannot store");
  const key = link.encKey;
  const expiresAtEpoch = epochSeconds(link.expiresAt);
  const now = ctx.clock.nowIso();
  const translated = result.meta.languages.filter((l) => l !== "en");
  const stored: StoredSummary = {
    summary: result.summaries.en,
    warnings: result.meta.safetyChecks.warnings,
    provider: result.meta.provider,
    model: result.meta.model,
    createdAt: now,
    sourceChars: result.meta.sourceChars,
    inputKind: opts.inputKind,
    readabilityGrade: result.meta.safetyChecks.readabilityGrade,
    fidelity: result.meta.safetyChecks.fidelity,
    stages: result.meta.stages,
    synthesizedLanguages: translated,
    synthesisCount: opts.synthesisCount,
  };
  await ctx.secureDocs.putJson({ linkIdHash: link.linkIdHash, doc: DOC.simplified, key, keyVersion: link.keyVersion, value: stored, expiresAtEpochSeconds: expiresAtEpoch, createdAt: now });
  const documents: string[] = [DOC.simplified];
  for (const lang of translated) {
    const t = result.meta.translations[lang];
    const stored: StoredTranslation = {
      translation: result.summaries[lang],
      backTranslation: result.backTranslations[lang],
      warnings: t?.warnings ?? [],
      provider: t?.provider ?? result.meta.provider,
      model: t?.model,
      createdAt: now,
    };
    const doc = DOC.translation(lang);
    await ctx.secureDocs.putJson({ linkIdHash: link.linkIdHash, doc, key, keyVersion: link.keyVersion, value: stored, expiresAtEpochSeconds: expiresAtEpoch, createdAt: now });
    await ctx.audit.append({ event: "translation.created", linkIdHash: link.linkIdHash, actor: "system", at: now, details: { language: lang, provider: stored.provider, model: stored.model, warningCount: stored.warnings.length, atSynthesis: true } });
    documents.push(doc);
  }
  return { documents };
}

async function deliver(ctx: AppContext, linkIdHash: string, kind: "patient" | "caregiver", mail: ReturnType<typeof patientLinkEmail>) {
  const at = ctx.clock.nowIso();
  if (ctx.emailQueue) {
    const r = await ctx.emailQueue.enqueue({ ...mail, linkIdHash, kind, enqueuedAt: at });
    await ctx.audit.append({ event: "email.queued", linkIdHash, actor: "system", at, details: { kind, queue: "sqs", messageId: r.messageId } });
    return;
  }
  const sent = await ctx.mailer.send(mail);
  await ctx.audit.append({ event: "email.sent", linkIdHash, actor: "system", at, details: { kind, transport: sent.transport, messageId: sent.messageId } });
}
