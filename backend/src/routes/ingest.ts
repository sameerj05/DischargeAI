import { Router } from "express";
import { z } from "zod";
import { LINK_TTL_MS } from "../config.js";
import type { AppContext } from "../context.js";
import { newDataKey } from "../crypto/envelope.js";
import { hashLinkId, hashPrefix, newLinkId } from "../crypto/linkId.js";
import { badRequest, notFound } from "../errors.js";
import { isEmptyText } from "../extract/text.js";
import { looksLikePdf } from "../extract/pdf.js";
import { resolveLanguages } from "../agents/pipeline.js";
import { resolveLanguage } from "../languages.js";
import { uploadMiddleware, type UploadedFiles } from "../middleware/upload.js";
import { synthesisLanguages } from "../pipeline/ingestJob.js";

const IngestFields = z.object({
  patientId: z.string().trim().min(1),
  text: z.string().optional(),
  /** Patient's preferred language (name or code); translated at synthesis unless it is English. */
  language: z.string().trim().optional(),
  /** More languages to translate at synthesis: repeat the field or comma-separate (es,zh,ar). */
  languages: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean))),
  caregiverEmail: z.string().trim().email().optional().or(z.literal("")),
  caregiverApproved: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase()))),
});

/**
 * POST /ingest (provider, multipart): patientId + exactly one of text | file (PDF) | audio.
 * Creates the link (hash + per-link key) and the job, answers 202 at once, and the pipeline runs
 * asynchronously. The raw link id appears in this response, the email and the patient row only.
 */
export function ingestRouter(ctx: AppContext): Router {
  const r = Router();
  const upload = uploadMiddleware(ctx.config.MAX_UPLOAD_BYTES);

  r.post("/ingest", upload, async (req, res) => {
    const fields = IngestFields.parse(req.body ?? {});
    const files = (req.files ?? {}) as UploadedFiles;
    const pdf = files.file?.[0];
    const audio = files.audio?.[0];
    const text = fields.text ?? "";

    const provided = [!isEmptyText(text), !!pdf, !!audio].filter(Boolean).length;
    if (provided === 0) throw badRequest("empty_input", "Provide text, a PDF file, or an audio clip");
    if (provided > 1) throw badRequest("multiple_inputs", "Provide exactly one of text, file or audio");
    if (pdf && (pdf.size === 0 || !looksLikePdf(pdf.buffer))) throw badRequest("empty_input", "The uploaded file is not a readable PDF");
    if (audio && audio.size === 0) throw badRequest("empty_input", "The audio clip is empty");
    if (ctx.config.LLM_PROVIDER !== "offline" && text.length > 200_000) throw badRequest("input_too_long", "Text is limited to 200,000 characters");

    const patient = await ctx.patients.getById(fields.patientId);
    if (!patient) throw notFound("patient_not_found", "Unknown patientId");

    if (fields.language && !resolveLanguage(fields.language)) throw badRequest("unsupported_language", `language "${fields.language}" is not in GET /languages`);
    const { languages: picked, unsupported } = resolveLanguages(fields.languages);
    if (unsupported.length) throw badRequest("unsupported_language", `Unsupported language(s): ${unsupported.join(", ")} (see GET /languages)`);
    const language = fields.language ? resolveLanguage(fields.language)!.code : patient.preferredLanguage ?? undefined;
    const languages = picked.map((l) => l.code);
    const linkId = newLinkId();
    const linkIdHash = hashLinkId(linkId);
    const createdAt = ctx.clock.now();
    const expiresAt = new Date(createdAt.getTime() + LINK_TTL_MS);
    const kind = pdf ? "pdf" : audio ? "audio" : "text";

    await ctx.links.create({
      linkIdHash,
      patientId: patient.id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      keyVersion: ctx.config.KEY_VERSION,
      encKey: newDataKey(),
      language: language ?? null,
      languages,
      caregiverEmail: fields.caregiverEmail || null,
      caregiverApproved: !!fields.caregiverEmail && fields.caregiverApproved,
    });
    const job = await ctx.jobs.create({
      linkIdHash,
      inputKind: kind,
      now: ctx.clock.nowIso(),
      meta: { inputBytes: pdf?.size ?? audio?.size ?? Buffer.byteLength(text, "utf8"), mimeType: pdf?.mimetype ?? audio?.mimetype },
    });
    const synthesis = synthesisLanguages({ language: language ?? null, languages });
    await ctx.audit.append({ event: "link.created", linkIdHash, actor: "provider", at: ctx.clock.nowIso(), details: { patientId: patient.id, jobId: job.id, inputKind: kind, expiresAt: expiresAt.toISOString(), language: language ?? null, synthesisLanguages: synthesis, caregiver: !!fields.caregiverEmail, caregiverApproved: !!fields.caregiverEmail && fields.caregiverApproved } });
    ctx.log.info({ jobId: job.id, link: hashPrefix(linkIdHash), inputKind: kind }, "ingest accepted");

    res.status(202).json({
      jobId: job.id,
      linkId,
      link: ctx.patientUrl(linkId),
      expiresAt: expiresAt.toISOString(),
      statusUrl: `/jobs/${job.id}`,
      patientUrl: `/p/${linkId}`,
      stage: job.stage,
      language: language ?? null,
      synthesisLanguages: synthesis,
    });

    ctx.enqueueIngest(job.id, {
      linkId,
      kind,
      text: kind === "text" ? text : undefined,
      file: pdf
        ? { buffer: pdf.buffer, mimeType: pdf.mimetype, fileName: pdf.originalname }
        : audio
          ? { buffer: audio.buffer, mimeType: audio.mimetype, fileName: audio.originalname }
          : undefined,
    });
  });

  return r;
}
