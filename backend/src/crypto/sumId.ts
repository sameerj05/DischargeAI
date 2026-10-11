import { createHash, randomBytes } from "node:crypto";

/**
 * The team contract's "random path to be used for the link": 256 random bits, base64url, 43
 * characters, unguessable. The same value is the `activeLinks.sumId` row, the DynamoDB `uid`
 * (and `sum-id` attribute), the `sum-id` / `sum_id` query parameter, the `/p/:token` path and the
 * AgentCore session id (AgentCore requires at least 33 characters).
 */
export function newSumId(): string {
  return randomBytes(32).toString("base64url");
}

const SUM_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export function isSumIdShaped(value: unknown): value is string {
  return typeof value === "string" && SUM_ID_RE.test(value);
}

/** Short, non-reversible handle for logs: the first 8 hex characters of sha256(sumId). Logs never carry the id itself. */
export function logRef(sumId: string): string {
  return createHash("sha256").update(sumId, "utf8").digest("hex").slice(0, 8);
}
