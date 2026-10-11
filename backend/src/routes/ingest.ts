import { Router } from "express";
import { z } from "zod";
import { LINK_TTL_MS } from "../config.js";
import type { AppContext } from "../context.js";
import { logRef, newSumId } from "../crypto/sumId.js";
import { audioKeyFor, pdfKeyFor } from "../data/objects.js";
import type { InputKind } from "../docstore/types.js";
import { AppError, badRequest, notFound } from "../errors.js";
import { decodePdfData, looksLikePdf, pdfToText, type PdfText } from "../extract/pdfToText.js";
import { isEmptyText, normalizeText } from "../extract/text.js";
import { uploadMiddleware, type UploadedFiles } from "../middleware/upload.js";

/** The patients table's id may be a number (an INT column) or text; both arrive here as text. */
const PatientIdField = z.union([z.string().trim(), z.number().int().transform(String)]).optional();

/** The team contract's body: { "data": ..., "type": "text" | "pdf", "patientID": ... }. Other keys are ignored. */
const JsonBody = z.object({
  data: z.unknown().optional(),
  type: z.unknown().optional(),
  patientID: PatientIdField,
  patientId: PatientIdField,
});

/** The earlier multipart form, kept as an alias: patientId + exactly one of text | file (PDF) | audio. */
const FormFields = z.object({
  patientId: z.string().trim().optional(),
  patientID: z.string().trim().optional(),
  text: z.string().optional(),
});

interface Parsed {
  kind: InputKind;
  patientId: string;
  text?: string;
  file?: { buffer: Buffer; mimeType: string; fileName?: string };
}

const MAX_LLM_CHARS = 200_000;

/**
 * POST /ingest (provider): the team contract's main endpoint. JSON `{ data, type, patientID }`.
 *
 * Before the answer: `type: "text"` takes the text in `data`; `type: "pdf"` takes the PDF in `data`
 * (base64, with or without a data: prefix), runs pdfToText on it, and stores the PDF in the PDF
 * bucket. Either way the clinician text goes on the DynamoDB item as `raw-text`, the random path
 * (sumId) goes into activeLinks and is the item's uid, and the job row is created. Any other type
 * fails with 400 "type must be text or pdf"; a PDF that holds no readable text fails with 400 too,
 * before anything is saved. Then it answers 202 "ingestion started".
 *
 * After the answer, in the background: send the text to the DischargeAI agent on AgentCore (session
 * id = the sum-id) and wait, save its whole response as `llm-summary` on the same item, email the link
 * to the patient and the caregiver. Nothing is translated. Multipart (patientId + text | file | audio) is accepted as an alias;
 * audio is transcribed in the background first because speech to text is too slow to wait for.
 */
export function ingestRouter(ctx: AppContext): Router {
  const r = Router();
  const upload = uploadMiddleware(ctx.config.MAX_UPLOAD_BYTES);

  r.post("/ingest", upload, async (req, res) => {
    const parsed = req.is("multipart/form-data") ? parseMultipart(req.body, (req.files ?? {}) as UploadedFiles) : parseJson(req.body);
    if (parsed.file && parsed.file.buffer.length > ctx.config.MAX_UPLOAD_BYTES) throw new AppError(413, "file_too_large", `The file is larger than ${ctx.config.MAX_UPLOAD_BYTES} bytes`);
    if ((parsed.text?.length ?? 0) > MAX_LLM_CHARS) throw badRequest("input_too_long", `Text is limited to ${MAX_LLM_CHARS.toLocaleString("en-US")} characters`);

    const patient = await ctx.patients.getById(parsed.patientId);
    if (!patient) throw notFound("patient_not_found", "Unknown patientID");

    // A PDF becomes text here, before anything is saved, so an unreadable one is refused outright.
    // From this point on every input kind but audio has its text in hand.
    let text = parsed.text !== undefined ? normalizeText(parsed.text) : undefined;
    let pdf: PdfText | undefined;
    if (parsed.kind === "pdf") {
      try {
        pdf = await pdfToText(parsed.file!.buffer);
      } catch (err) {
        throw badRequest("unreadable_pdf", `The PDF could not be turned into text: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      }
      text = pdf.text;
      if (text.length > MAX_LLM_CHARS) throw badRequest("input_too_long", `The PDF holds more than ${MAX_LLM_CHARS.toLocaleString("en-US")} characters of text`);
    }

    const sumId = newSumId();
    const createdAt = ctx.clock.now();
    const expiresAt = new Date(createdAt.getTime() + LINK_TTL_MS);
    const { kind } = parsed;

    let pdfKey: string | undefined;
    let audioKey: string | undefined;
    let itemSaved = false;
    try {
      // The PDF goes to the PDF bucket and an audio clip to the audio bucket before the 202, so the bytes are durable.
      if (kind === "pdf") {
        pdfKey = pdfKeyFor(sumId);
        await ctx.pdf.put({ key: pdfKey, body: parsed.file!.buffer, contentType: "application/pdf" });
      } else if (kind === "audio") {
        audioKey = audioKeyFor(sumId, parsed.file!.mimeType, parsed.file!.fileName);
        await ctx.audio.put({ key: audioKey, body: parsed.file!.buffer, contentType: parsed.file!.mimeType });
      }

      // One item per summary in the document store. `raw-text` is on it before the answer for text and PDF.
      await ctx.summaries.put({
        uid: sumId,
        "sum-id": sumId,
        patientID: patient.id,
        ...(text !== undefined ? { "raw-text": text } : {}),
        status: "processing",
        createdAt: createdAt.toISOString(),
        expiresAt: Math.floor(expiresAt.getTime() / 1000),
        inputKind: kind,
        ...(pdfKey ? { pdfKey } : {}),
        ...(audioKey ? { audioKey } : {}),
        ...(pdf ? { meta: { pdfPages: pdf.pages, pdfEngine: pdf.engine, sourceChars: pdf.text.length } } : {}),
      });
      itemSaved = true;
      await ctx.activeLinks.create({ sumId, patientID: patient.id, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), pdfKey, audioKey });
    } catch (err) {
      // Nothing may be left behind for a link that was never created: no orphan item or object.
      if (itemSaved) await ctx.summaries.delete(sumId).catch(() => undefined);
      if (pdfKey) await ctx.pdf.delete(pdfKey).catch(() => undefined);
      if (audioKey) await ctx.audio.delete(audioKey).catch(() => undefined);
      throw err;
    }

    const job = await ctx.jobs.create({
      sumId,
      inputKind: kind,
      now: ctx.clock.nowIso(),
      meta: {
        inputBytes: parsed.file?.buffer.length ?? Buffer.byteLength(text ?? "", "utf8"),
        mimeType: parsed.file?.mimeType,
        ...(pdf ? { pdfPages: pdf.pages, pdfEngine: pdf.engine, sourceChars: pdf.text.length, pdfStore: ctx.pdf.name } : {}),
        ...(audioKey ? { audioStore: ctx.audio.name } : {}),
      },
    });
    await ctx.audit.append({ event: "link.created", sumId, actor: "provider", at: ctx.clock.nowIso(), details: { patientId: patient.id, jobId: job.id, inputKind: kind, expiresAt: expiresAt.toISOString(), pdfStored: !!pdfKey, audioStored: !!audioKey } });
    ctx.log.info({ jobId: job.id, link: logRef(sumId), inputKind: kind }, "ingest accepted");

    res.status(202).json({
      statusCode: 202,
      message: "ingestion started",
      sumId,
      link: ctx.patientUrl(sumId),
      jobId: job.id,
      expiresAt: expiresAt.toISOString(),
      statusUrl: `/jobs/${job.id}`,
      stage: job.stage,
      linkId: sumId,
      status: "ingestion started",
    });

    ctx.enqueueIngest(job.id, kind === "audio" ? { sumId, kind, file: parsed.file } : undefined);
  });

  return r;
}

function parseJson(body: unknown): Parsed {
  const b = JsonBody.parse(body && typeof body === "object" ? body : {});
  const type = typeof b.type === "string" ? b.type.trim().toLowerCase() : "";
  if (type !== "text" && type !== "pdf") throw badRequest("invalid_type", "type must be text or pdf");
  const patientId = b.patientID || b.patientId;
  if (!patientId) throw badRequest("missing_patientID", "patientID is required");
  if (typeof b.data !== "string") throw badRequest("missing_data", type === "pdf" ? "data must be the PDF as a base64 string" : "data must be the discharge summary text");
  if (type === "text") {
    if (isEmptyText(b.data)) throw badRequest("empty_input", "data is empty");
    return { kind: "text", patientId, text: b.data };
  }
  const buffer = decodePdfData(b.data);
  if (!buffer.length || !looksLikePdf(buffer)) throw badRequest("empty_input", "data is not a base64-encoded PDF");
  return { kind: "pdf", patientId, file: { buffer, mimeType: "application/pdf", fileName: "upload.pdf" } };
}

function parseMultipart(body: unknown, files: UploadedFiles): Parsed {
  const fields = FormFields.parse(body ?? {});
  const patientId = fields.patientId || fields.patientID;
  if (!patientId) throw badRequest("missing_patientID", "patientId is required");
  const pdf = files.file?.[0];
  const audio = files.audio?.[0];
  const text = fields.text ?? "";
  const provided = [!isEmptyText(text), !!pdf, !!audio].filter(Boolean).length;
  if (provided === 0) throw badRequest("empty_input", "Provide text, a PDF file, or an audio clip");
  if (provided > 1) throw badRequest("multiple_inputs", "Provide exactly one of text, file or audio");
  if (pdf && (pdf.size === 0 || !looksLikePdf(pdf.buffer))) throw badRequest("empty_input", "The uploaded file is not a readable PDF");
  if (audio && audio.size === 0) throw badRequest("empty_input", "The audio clip is empty");
  if (pdf) return { kind: "pdf", patientId, file: { buffer: pdf.buffer, mimeType: pdf.mimetype, fileName: pdf.originalname } };
  if (audio) return { kind: "audio", patientId, file: { buffer: audio.buffer, mimeType: audio.mimetype, fileName: audio.originalname } };
  return { kind: "text", patientId, text };
}
