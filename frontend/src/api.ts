const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001"

export type IngestPayload = {
  data: string
  type: "text" | "pdf" | "dictation"
  patientId: string
}

export type IngestResponse = {
  status: string
  patientId: string
  type: string
  charCount: number
  message: string
}

export type OutputResponse = {
  status: string
  patientId: string
  plan: unknown | null
  message: string
}

/**
 * POST /ingest
 * Sends the physician's text input to the backend for processing.
 */
export async function postIngest(payload: IngestPayload): Promise<IngestResponse> {
  const res = await fetch(`${BASE_URL}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? `Ingest failed (${res.status})`)
  }

  return res.json()
}

/**
 * GET /output/:patientId
 * Fetches the discharge plan for a patient.
 */
export async function getOutput(patientId: string): Promise<OutputResponse> {
  const res = await fetch(`${BASE_URL}/output/${encodeURIComponent(patientId)}`)

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? `Output fetch failed (${res.status})`)
  }

  return res.json()
}
