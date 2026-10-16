import type { Request } from "express";
import { z } from "zod";
import { AppError } from "./errors.ts";
import { MONEY_RE } from "./format.ts";
import { checkPhone, PHONE_MESSAGES } from "./phone.ts";

// ---------- pagination: { items, page, pageSize, total }, pageSize capped at 100 ----------
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
type Page = z.infer<typeof pageQuery>;
export const paged = (p: Page) => ({ skip: (p.page - 1) * p.pageSize, take: p.pageSize });
export const listOf = <T>(items: T[], p: Page, total: number) => ({ items, page: p.page, pageSize: p.pageSize, total });

// A malformed id can never match a row: answer 404 instead of letting PostgreSQL reject the cast.
const uuid = z.uuid();
export function idParam(req: Request): string {
  const r = uuid.safeParse(req.params.id);
  if (!r.success) throw new AppError(404, "NOT_FOUND", "Record not found.");
  return r.data;
}

// ---------- field schemas ----------
// Optional text fields: "" or whitespace from a form means "no value" (null).
export const blankToNull = <T extends z.ZodType>(s: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), s.nullable().optional());

export const text = (max: number) => z.string().trim().min(1, "Required").max(max);
export const optText = (max: number) => blankToNull(z.string().trim().max(max));
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Invalid email"));
// Validated with the international numbering plan (lib/phone.ts) and returned as E.164, e.g. "+919876543210".
export const phone = z
  .string()
  .trim()
  .max(40, PHONE_MESSAGES.invalid)
  .transform((value, ctx) => {
    const result = checkPhone(value);
    if ("e164" in result) return result.e164;
    ctx.addIssue({ code: "custom", message: result.error });
    return z.NEVER;
  });
export const password = z.string().min(8, "Use at least 8 characters").max(128, "Use at most 128 characters");
export const dateOnlyStr = z.iso.date("Use YYYY-MM-DD");
export const searchQ = z.string().trim().max(100).optional();

// Accepts 249000, 249000.5 or "249000.50"; returns a string so PostgreSQL NUMERIC gets it without float rounding.
export const money = z
  .union([z.number(), z.string().trim()])
  .transform(String)
  .pipe(z.string().regex(MONEY_RE, "Must be a non-negative amount with at most 2 decimals"));

export const weightKg = z
  .union([z.number(), z.string().trim()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,7}(\.\d{1,3})?$/, "Must be a non-negative weight with at most 3 decimals"));
