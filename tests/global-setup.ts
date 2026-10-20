import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Applies every migration to the test database — the same `migrate deploy` production runs.
export default function setup() {
  const testDb = process.env.TEST_DATABASE_URL!;
  let appEnv: Record<string, string | undefined> = {};
  try {
    appEnv = parseEnv(readFileSync(".env", "utf8"));
  } catch {
    // no .env
  }
  // Same server + database = same data, however the URL is written (pooled/direct host, user, query params).
  const target = (url?: string) => {
    if (!url) return null;
    const u = new URL(url);
    return `${u.hostname.replace("-pooler.", ".").toLowerCase()}:${u.port || 5432}${u.pathname}`;
  };
  const names = ["DATABASE_URL", "DIRECT_URL", "DATABASE_UNPOOLED_URL"];
  const appTargets = names.flatMap((n) => [appEnv[n], process.env[n]]).map(target);
  if (appTargets.includes(target(testDb)))
    throw new Error("TEST_DATABASE_URL points at the app database — refusing to wipe it.");

  // Prisma Migrate takes an advisory lock, which needs Neon's direct endpoint: same host without "-pooler".
  const direct = process.env.TEST_DIRECT_URL ?? testDb.replace("-pooler.", ".");
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DIRECT_URL: direct, DATABASE_URL: direct } });
}
