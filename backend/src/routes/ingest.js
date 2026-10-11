import { Router } from "express"

export const ingestRouter = Router()

/**
 * POST /ingest
 *
 * Receives a physician's text input and queues it for processing.
 *
 * Expected body:
 * {
 *   "data":      string   — the text content (written note, transcript, or extracted PDF text)
 *   "type":      "text" | "pdf" | "dictation"
 *   "patientId": string   — opaque patient identifier
 * }
 *
 * TODO: replace stub with real pipeline —
 *   1. Validate + sanitize input
 *   2. Send `data` to LLM / processing service
 *   3. Store result against patientId (DynamoDB, RDS, etc.)
 *   4. Return a jobId the frontend can poll if processing is async
 */
ingestRouter.post("/", (req, res) => {
  const { data, type, patientId } = req.body

  // ── Validation ──
  if (!data || typeof data !== "string" || data.trim().length === 0) {
    return res.status(400).json({ error: "data is required and must be a non-empty string" })
  }

  if (!type || !["text", "pdf", "dictation"].includes(type)) {
    return res.status(400).json({ error: "type must be one of: text, pdf, dictation" })
  }

  if (!patientId || typeof patientId !== "string") {
    return res.status(400).json({ error: "patientId is required" })
  }

  // ── Stub response ──
  console.log(`[ingest] Received ${type} input for patient ${patientId} (${data.length} chars)`)

  return res.status(202).json({
    status: "accepted",
    patientId,
    type,
    charCount: data.length,
    message: "Input received. Processing pipeline not yet connected.",
  })
})
