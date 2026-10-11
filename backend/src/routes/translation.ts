import { Router } from "express";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";

/**
 * The team contract's `GET /translation?lang=&sum_id=` and its earlier spelling `GET /translate`.
 * Translation of the agent's response is not built yet, so both answer 501.
 */
export function translationRouter(_ctx: AppContext): Router {
  const r = Router();
  const notYet = () => {
    throw new AppError(501, "not_implemented", "Translation is not implemented yet");
  };
  r.get("/translation", notYet);
  r.get("/translate", notYet);
  return r;
}
