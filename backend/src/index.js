import express from "express"
import cors from "cors"
import { ingestRouter } from "./routes/ingest.js"
import { outputRouter } from "./routes/output.js"

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json())

// ── Physician side ──
// POST /ingest  — receives text input from the doctor and stores it
app.use("/ingest", ingestRouter)

// ── Patient side ──
// GET  /output/:patientId  — returns the processed discharge plan for a patient
app.use("/output", outputRouter)

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`DischargeAI backend running on http://localhost:${PORT}`)
})
