import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../generated/prisma/client.ts";
import { AppError, isUniqueViolation } from "../lib/errors.ts";

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const fields = Object.fromEntries(err.issues.map((i) => [i.path.join(".") || "body", i.message]));
    return new AppError(422, "VALIDATION_FAILED", "The submitted data is invalid.", fields);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (isUniqueViolation(err)) return new AppError(409, "CONFLICT", "A record with the same unique value already exists.");
    if (err.code === "P2003") return new AppError(409, "IN_USE", "This record is still referenced by other records.");
    if (err.code === "P2025") return new AppError(404, "NOT_FOUND", "Record not found.");
    if (err.code === "P2034") return new AppError(409, "RETRY", "The data changed while saving. Please try again.");
    if (err.code === "P2028") return new AppError(503, "DB_TIMEOUT", "The database took too long to respond. Nothing was saved. Please try again.");
    // Database unreachable, connection dropped (e.g. Neon suspending), or no free pooled connection: retryable,
    // and worth saying so rather than "Something went wrong".
    if (["P1001", "P1002", "P1008", "P1017", "P2024"].includes(err.code))
      return new AppError(503, "DB_UNAVAILABLE", "The database couldn't be reached just now. Please try again in a moment.");
  }
  const body = err as { type?: string };
  if (body?.type === "entity.parse.failed") return new AppError(400, "MALFORMED_JSON", "Request body is not valid JSON.");
  if (body?.type === "entity.too.large") return new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  return new AppError(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}

export const notFoundRoute: RequestHandler = (_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Route not found."));

// Responses never carry stack traces or SQL; 5xx details go to the log with the request id.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const e = toAppError(err);
  if (e.status >= 500) req.log?.error({ err }, "unhandled error");
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.fields && { fields: e.fields }) } });
};
