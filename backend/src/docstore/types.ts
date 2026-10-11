/**
 * The team contract's DynamoDB layout: ONE item per summary in `discharge-summaries`, hash key
 * `uid` = the sumId (the random link path), with the attributes teammates read and write directly:
 *   sum-id        the same value as uid
 *   patientID     the patient the summary belongs to
 *   raw-text      the clinician text (pasted, extracted from the PDF, or the transcript)
 *   llm-summary   the DischargeAI agent's whole response, exactly as it came back
 *                 (on the live runtime: status, flags, summary, plan)
 *   status        processing | ready | failed
 *   createdAt     ISO-8601
 *   expiresAt     epoch seconds, the table's TTL attribute (createdAt + 30 days)
 * Nothing is encrypted at the application layer: DynamoDB encrypts at rest. The remaining attributes
 * are the backend's own metadata (input kind, object keys in the buckets, the agent run).
 */
export type InputKind = "text" | "pdf" | "audio";
export type SummaryStatus = "processing" | "ready" | "failed";

export interface SummaryMeta {
  provider?: string;
  /** The AgentCore runtime that produced llm-summary. */
  agentRuntimeArn?: string;
  latencyMs?: number;
  sourceChars?: number;
  pdfPages?: number;
  pdfEngine?: string;
  transcript?: { provider: string; jobName?: string; latencyMs?: number };
}

export interface SummaryItem {
  uid: string;
  "sum-id": string;
  patientID: string;
  "raw-text"?: string;
  "llm-summary"?: unknown;
  status: SummaryStatus;
  createdAt: string;
  expiresAt: number;
  inputKind: InputKind;
  pdfKey?: string;
  audioKey?: string;
  meta?: SummaryMeta;
}

/** Top-level attributes a caller may set after creation (the agent response, status, metadata). */
export type SummaryPatch = Partial<Omit<SummaryItem, "uid" | "createdAt" | "patientID">>;

export interface SummaryStore {
  readonly name: "dynamo";
  /** Where the items live, for logs and /health (the table). */
  readonly describe: string;
  put(item: SummaryItem): Promise<void>;
  get(uid: string): Promise<SummaryItem | null>;
  /** Sets the given top-level attributes on an existing item (DynamoDB UpdateItem SET). */
  update(uid: string, patch: SummaryPatch): Promise<void>;
  /** Deletes the item. Returns false when nothing was there. */
  delete(uid: string): Promise<boolean>;
  /** Items whose TTL has passed, for the purge job's backstop sweep. */
  listExpired(nowEpochSeconds: number, limit?: number): Promise<{ uid: string; expiresAt: number }[]>;
}
