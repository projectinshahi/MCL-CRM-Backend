import { createApp } from "./app.ts";
import { emailConfigured, env } from "./config/env.ts";
import { logger } from "./lib/logger.ts";
import { prisma, warmPool } from "./lib/prisma.ts";

const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, "MCL CRM API listening"));
// The Next.js proxy reuses connections and drops idle ones after 5 s — the same as Node's server default, so a
// request could land on a socket the API was closing (ECONNRESET → 500 in the browser). Outlive the client.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000; // must exceed keepAliveTimeout
if (!emailConfigured) logger.warn("SMTP_URL / EMAIL_FROM not set: forgot-password codes will not be emailed");

// Open the database connections now, not on the first user's click (each TLS handshake to Neon costs seconds).
const warmStart = Date.now();
warmPool()
  .then(() => logger.info({ connections: env.DATABASE_POOL_MAX, ms: Date.now() - warmStart }, "database pool warmed"))
  .catch((err) => logger.warn({ err }, "database pool warm-up failed; connections will open on demand"));

// Purge expired sessions and finished password resets hourly.
const purge = setInterval(async () => {
  try {
    const now = new Date();
    await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
    await prisma.passwordReset.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } } });
  } catch (err) {
    logger.error({ err }, "purge failed");
  }
}, 60 * 60 * 1000);
purge.unref();

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  clearInterval(purge);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // in-flight requests get 10 s
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
