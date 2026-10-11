/** Errors that map straight to an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (code = "not_found", message?: string) => new AppError(404, code, message);
export const badRequest = (code = "bad_request", message?: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = "unauthorized", message?: string) => new AppError(401, code, message);
export const gone = (code = "gone", message?: string, details?: unknown) => new AppError(410, code, message, details);
export const tooEarly = (code = "processing", message?: string, details?: unknown) =>
  new AppError(425, code, message, details);
