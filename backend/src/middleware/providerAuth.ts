import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { unauthorized } from "../errors.js";

/** Provider endpoints require `x-provider-key`. Compared in constant time. */
export function providerAuth(expectedKey: string): RequestHandler {
  const expected = Buffer.from(expectedKey, "utf8");
  return (req, _res, next) => {
    const header = req.header("x-provider-key");
    const given = Buffer.from(typeof header === "string" ? header : "", "utf8");
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      next(unauthorized("provider_key_required", "Missing or invalid x-provider-key header"));
      return;
    }
    next();
  };
}
