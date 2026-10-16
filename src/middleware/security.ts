import type { RequestHandler } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { env } from "../config/env.ts";
import { AppError } from "../lib/errors.ts";

// CSRF defence alongside SameSite=Lax: every state-changing request must come from the MCL frontend's origin.
export const originCheck: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || env.FRONTEND_ORIGIN.includes(req.get("origin") ?? "")) return next();
  next(new AppError(403, "ORIGIN_REJECTED", "Request origin is not allowed."));
};

const tooMany: Options["handler"] = (_req, _res, next) =>
  next(new AppError(429, "RATE_LIMITED", "Too many requests. Please wait and try again."));

// ponytail: in-memory counters are per process; switch to a shared store (e.g. Redis) when running more than one API instance
const limiter = (windowMs: number, limit: number, keyGenerator?: Options["keyGenerator"], more: Partial<Options> = {}) =>
  rateLimit({ windowMs, limit, keyGenerator, handler: tooMany, standardHeaders: "draft-8", legacyHeaders: false, ...more });

// The account a login is for, read the way the login schema reads it (trimmed, lower-cased): " a@b.co" and
// "a@b.co " are one account, so they must be one counter.
const account = (req: Parameters<NonNullable<Options["keyGenerator"]>>[0]) => String(req.body?.email ?? "").trim().toLowerCase();

export const apiLimiter = limiter(60_000, 300);
// Login: 5 attempts per minute per IP + email (report section 9 proposal).
export const loginLimiter = limiter(60_000, 5, (req) => `${ipKeyGenerator(req.ip ?? "")}|${account(req)}`);
// And per account from all addresses together, failed sign-ins only: guessing one password stays slow even from
// many IPs (or with a forged X-Forwarded-For). Ten wrong passwords lock that account's sign-in for 15 minutes.
export const loginAccountLimiter = limiter(15 * 60_000, 10, (req) => `account|${account(req)}`, { skipSuccessfulRequests: true });
// Forgot-password, OTP verify and reset share a per-IP budget; per-account resend and attempt limits live in the database.
export const passwordResetLimiter = limiter(15 * 60_000, 20);
