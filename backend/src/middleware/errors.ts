import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";

/**
 * Express 5 routes async errors here without wrappers. Every error body carries `statusCode` and
 * `message` (the team contract's shape, e.g. `{ statusCode: 400, message: "type must be text or pdf" }`)
 * plus the stable machine-readable `error` code. zod -> 400, AppError -> its status, else 500.
 */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      res.status(400).json({ statusCode: 400, error: "validation_error", message, issues: err.issues });
      return;
    }
    if (err instanceof AppError) {
      const body: Record<string, unknown> = { statusCode: err.status, error: err.code, message: err.message };
      if (err.details !== undefined) Object.assign(body, err.details);
      res.status(err.status).json(body);
      return;
    }
    const anyErr = err as { code?: string; type?: string; status?: number; message?: string };
    if (anyErr?.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ statusCode: 413, error: "file_too_large", message: anyErr.message });
      return;
    }
    if (anyErr?.type === "entity.too.large") {
      res.status(413).json({ statusCode: 413, error: "file_too_large", message: "The request body is larger than MAX_UPLOAD_BYTES allows" });
      return;
    }
    if (anyErr?.type === "entity.parse.failed") {
      res.status(400).json({ statusCode: 400, error: "invalid_json", message: "The request body is not valid JSON" });
      return;
    }
    log.error({ err: { name: (err as Error)?.name, message: (err as Error)?.message } }, "unhandled error");
    res.status(500).json({ statusCode: 500, error: "internal_error", message: "Internal error" });
  };
}
