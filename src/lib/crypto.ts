import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.ts";

// Session ids and reset tokens: 256-bit random, only their SHA-256 is stored.
export const newToken = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// 6-digit OTP. Stored as an HMAC keyed by SESSION_SECRET and bound to its reset row, so a DB leak alone cannot brute-force it.
export const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const hashOtp = (otp: string, resetId: string) =>
  createHmac("sha256", env.SESSION_SECRET).update(`${resetId}:${otp}`).digest("hex");

export const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
