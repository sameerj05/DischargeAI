import type { SummaryResponse } from "../../scripts/verification/contracts.js"
export type { SummaryResponse } from "../../scripts/verification/contracts.js"

// Test client for the backend API contract; independent of the restored demo frontend.
const BASE_URL = "/api"

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message) }
}
export type Patient = {
  ID: string | number; DOB: string | null; FirstName: string | null; LastName: string | null
  ZipCode: string | null; email: string | null; phoneNumber: string | null
  caregiverEmail: string | null; caregiverName: string | null
}
export type IngestResponse = {
  statusCode: number; message: string; sumId: string; link: string; jobId: string; expiresAt: string
}
export type Job = { jobId: string; stage: string; error: string | null }

async function request<T>(path: string, init: RequestInit = {}, providerKey?: string): Promise<T> {
  const headers = new Headers(init.headers)
  if (providerKey) headers.set("x-provider-key", providerKey)
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, cache: "no-store" })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body?.message || `Request failed (${res.status})`, body?.error)
  if (body === null) throw new Error("The API returned an invalid response. Check the backend URL.")
  return body as T
}
export async function getPatients(providerKey: string): Promise<Patient[]> {
  return (await request<{ patients: Patient[] }>("/patients", {}, providerKey)).patients
}
export function postIngest(payload: { data: string; type: "text" | "pdf"; patientID: string }, providerKey: string) {
  return request<IngestResponse>("/ingest", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, providerKey)
}
export function postAudio(audio: Blob, patientID: string, providerKey: string) {
  const form = new FormData()
  form.set("patientID", patientID)
  const ext = audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "mp4" : "webm"
  form.set("audio", audio, `dictation.${ext}`)
  return request<IngestResponse>("/ingest", { method: "POST", body: form }, providerKey)
}
export function getJob(jobId: string, providerKey: string, signal?: AbortSignal) {
  return request<Job>(`/jobs/${encodeURIComponent(jobId)}`, { signal }, providerKey)
}
export function getSummary(token: string, signal?: AbortSignal) {
  return request<SummaryResponse>(`/p/${encodeURIComponent(token)}`, { signal })
}
export function getServerMode(signal?: AbortSignal) {
  return request<{ mode?: string }>("/health", { signal })
}
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1])
    reader.onerror = () => reject(new Error("The PDF could not be read."))
    reader.readAsDataURL(file)
  })
}
