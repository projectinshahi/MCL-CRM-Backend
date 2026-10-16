import { isSupportedCountry } from "libphonenumber-js/max";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Neon pooled URL (host contains "-pooler", sslmode=require). Migrations use DIRECT_URL via prisma.config.ts.
  DATABASE_URL: z.string().min(1, "is required"),
  // node-postgres pool size per API process.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Exact origin of the Next.js app, or several separated by commas (in development `next dev` moves to 3001 when
  // another app holds 3000); state-changing requests from any other origin are rejected.
  FRONTEND_ORIGIN: z.string().transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)).pipe(z.array(z.url()).min(1)),
  // Server-side secret used to hash password-reset OTPs (HMAC key).
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Express "trust proxy": hop count ("1") or a preset such as "loopback".
  TRUST_PROXY: z.string().default("loopback"),
  // Any nodemailer SMTP URL, e.g. smtps://user:pass@smtp.example.com:465
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // Lead attachments are stored in Cloudinary (private assets). Without all three, file uploads are refused with a
  // clear message and everything else keeps working. Server-side only: the secret never reaches the browser.
  CLOUDINARY_CLOUD_NAME: z.string().trim().optional(),
  CLOUDINARY_API_KEY: z.string().trim().optional(),
  CLOUDINARY_API_SECRET: z.string().trim().optional(),
  // public_id prefix for this environment's files, e.g. "mcl-crm" (production) or "mcl-crm-dev".
  CLOUDINARY_FOLDER: z.string().trim().regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, "letters, digits, - _ and /").default("mcl-crm"),
  // ISO 3166 country used to read phone numbers sent without "+country code" (older API callers, legacy rows).
  // The app sends E.164 ("+91…"), so this only matters for those. MCL is India-based, hence "IN".
  DEFAULT_PHONE_COUNTRY: z
    .string()
    .trim()
    .toUpperCase()
    .default("IN")
    .refine((c) => isSupportedCountry(c), "must be a supported ISO country code such as IN, AE or GB"),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Variable names and rules only — never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}

export const env = load();
export const emailConfigured = Boolean(env.SMTP_URL && env.EMAIL_FROM);
export const storageConfigured = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
