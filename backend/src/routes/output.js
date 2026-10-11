import { Router } from "express"

export const outputRouter = Router()

/**
 * GET /output/:patientId
 *
 * Returns the processed discharge plan for a patient.
 *
 * TODO: replace stub with real data fetch —
 *   1. Authenticate the request (verify patient token)
 *   2. Look up the discharge plan by patientId from the database
 *   3. Return the full DischargePlan object (see frontend/src/data.ts for shape)
 */
outputRouter.get("/:patientId", (req, res) => {
  const { patientId } = req.params

  if (!patientId || typeof patientId !== "string") {
    return res.status(400).json({ error: "patientId is required" })
  }

  // ── Stub response ──
  console.log(`[output] Discharge plan requested for patient ${patientId}`)

  return res.status(200).json({
    status: "stub",
    patientId,
    plan: null,
    message: "Output endpoint reached. Database lookup not yet connected.",
  })
})
