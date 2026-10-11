import type { SummaryResponse } from "./contracts.js"
export type { SummaryResponse } from "./contracts.js"

const BASE_URL = import.meta.env.VITE_API_URL ?? "/api"

export const PROVIDER_KEY = import.meta.env.VITE_PROVIDER_KEY ?? "dev-provider-key"

export function dictationSocketUrl() {
  const url = new URL(BASE_URL.replace(/\/$/, "") + "/dictation", window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export type ContractPatient = { ID: string | number; DOB: string | null; FirstName: string | null; LastName: string | null }
export type Accepted = { message: string; sumId: string; jobId: string; link: string; expiresAt: string; appended?: boolean }
export type Job = { stage: string; error: string | null }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE_URL + path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(response.status, body.message ?? body.error ?? `Request failed (${response.status})`)
  return body
}

const provider = (key: string) => ({ "x-provider-key": key })

/** GET /patients: the rows of the patientinfo table. */
export async function getPatients(key: string) {
  return (await request<{ patients: ContractPatient[] }>("/patients", { headers: provider(key) })).patients
}

/** POST /ingest: with DOB, an active plan for the patient is appended to instead of replaced. */
export function postIngest(payload: { data: string; patientId: string; DOB?: string }, key: string) {
  return request<Accepted>("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...provider(key) },
    body: JSON.stringify({ data: payload.data, type: "text", patientID: payload.patientId, DOB: payload.DOB }),
  })
}

/** Polls GET /jobs/:id until the plan is ready. */
export async function waitForJob(jobId: string, key: string) {
  const deadline = Date.now() + 31 * 60_000
  while (Date.now() < deadline) {
    const job = await request<Job>(`/jobs/${encodeURIComponent(jobId)}`, { headers: provider(key) })
    if (job.stage === "failed") throw new Error(job.error ?? "Preparation failed")
    if (["done", "needs_review"].includes(job.stage)) return job
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("Preparation is still running. Check its status later.")
}

export const getSummary = (token: string) => request<SummaryResponse>(`/p/${encodeURIComponent(token)}`)

export const getTranslation = (token: string, lang: string) =>
  request<SummaryResponse>(`/translation?sum_id=${encodeURIComponent(token)}&lang=${encodeURIComponent(lang)}`)
