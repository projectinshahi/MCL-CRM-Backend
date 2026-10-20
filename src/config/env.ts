import { isSupportedCountry } from "libphonenumber-js/max";
import { z } from "zod";

// The compiled build (dist/, what `npm start` runs) is the production artifact: it runs as production unless
// NODE_ENV says otherwise, so a host that never sets NODE_ENV still gets Secure cookies and the checks below.
// `npm run dev` and the tests run the TypeScript sources, which default to development.
const compiled = import.meta.url.endsWith(".js");

// Express "trust proxy": "false"/"true" are booleans (as strings Express reads them as IP addresses and refuses to
// start), digits a hop count, anything else an IP / subnet / preset list such as "loopback".
const trustProxy = (v: string) => (v === "false" ? false : v === "true" ? true : /^\d+$/.test(v) ? Number(v) : v);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default(compiled ? "production" : "development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Neon pooled URL (host contains "-pooler"). Migrations use the direct URL via prisma.config.ts.
  DATABASE_URL: z.string().min(1, "is required").regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL"),
  // node-postgres pool size per API process.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Origin of the Next.js app, or several separated by commas (in development `next dev` moves to 3001 when another
  // app holds 3000); state-changing requests from any other origin are rejected. Kept as bare origins: a browser's
  // Origin header never ends in "/", so "https://crm.example.com/" would have refused every save.
  FRONTEND_ORIGIN: z
    .string()
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean))
    .pipe(z.array(z.url()).min(1))
    .transform((list) => list.map((o) => new URL(o).origin)),
  // Server-side secret used to hash password-reset OTPs (HMAC key).
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Default false: the Next.js rewrite passes on whatever X-Forwarded-For the browser sent, so trusting it (e.g.
  // "loopback" with Next on the same host) let anyone pick their own address and dodge per-address rate limits.
  TRUST_PROXY: z.string().trim().default("false").transform(trustProxy),
  // Any nodemailer SMTP URL, e.g. smtps://user:pass@smtp.example.com:465 — both or neither (see the checks below).
  SMTP_URL: z.string().trim().optional(),
  EMAIL_FROM: z.string().trim().optional(),
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

export type Env = z.infer<typeof schema>;
const isLocal = (origin: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);

/** Settings that parse but cannot work together. Names and origins only — never a secret's value. */
function conflicts(e: Env) {
  const problems: string[] = [];
  const some = (...v: (string | undefined)[]) => v.some(Boolean) && !v.every(Boolean);
  if (some(e.SMTP_URL, e.EMAIL_FROM)) problems.push("SMTP_URL and EMAIL_FROM: set both (password-reset emails) or neither");
  if (some(e.CLOUDINARY_CLOUD_NAME, e.CLOUDINARY_API_KEY, e.CLOUDINARY_API_SECRET))
    problems.push("CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET: set all three (file uploads) or none");
  if (e.NODE_ENV === "production") {
    // Session cookies are Secure in production: over plain http the browser drops them and nobody can sign in.
    for (const o of e.FRONTEND_ORIGIN) if (o.startsWith("http:") && !isLocal(o)) problems.push(`FRONTEND_ORIGIN: ${o} must use https in production`);
    // The test suite's secret is in the repository (vitest.config.ts), so it is no secret.
    if (e.SESSION_SECRET.startsWith("test-only-secret")) problems.push("SESSION_SECRET: the test suite's value must not be used in production; generate a new one");
  }
  return problems;
}

/** Reads and checks the configuration; throws listing every problem by variable name. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  const problems = parsed.success ? conflicts(parsed.data) : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  if (problems.length) throw new Error(`Invalid environment configuration:\n  ${problems.join("\n  ")}`);
  return parsed.data!;
}

export const env = loadEnv();
export const emailConfigured = Boolean(env.SMTP_URL && env.EMAIL_FROM);
export const storageConfigured = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
/** Production with the frontend's origin on this machine: a local run of the production build, not a deployment. */
export const localOriginsInProduction = env.NODE_ENV === "production" && env.FRONTEND_ORIGIN.some(isLocal);
