import type { RequestHandler } from "express";

/**
 * A small in-memory token bucket per client IP for the patient endpoints. The 128-bit link id makes
 * guessing infeasible on its own; this just keeps a noisy client from hammering the store.
 */
export function rateLimit(opts: { capacity: number; refillPerSecond: number }): RequestHandler {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: opts.capacity, updatedAt: now };
    const elapsed = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSecond);
    b.updatedAt = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}
