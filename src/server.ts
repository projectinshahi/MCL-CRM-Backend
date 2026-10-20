import { createApp } from "./app.ts";
import { emailConfigured, env, localOriginsInProduction, storageConfigured } from "./config/env.ts";
import { logger } from "./lib/logger.ts";
import { notificationsSettled } from "./lib/notify.ts";
import { prisma, warmPool } from "./lib/prisma.ts";
import { startReminders, stopReminders } from "./modules/notifications/reminders.ts";

const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, "MCL CRM API listening"));
// The Next.js proxy reuses connections and drops idle ones after 5 s — the same as Node's server default, so a
// request could land on a socket the API was closing (ECONNRESET → 500 in the browser). Outlive the client.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000; // must exceed keepAliveTimeout
// Optional integrations that are off, by variable name (never values).
if (!emailConfigured) logger.warn("SMTP_URL / EMAIL_FROM not set: Forgot password is unavailable (an administrator resets passwords in Users)");
if (!storageConfigured) logger.warn("CLOUDINARY_* not set: file uploads are refused; everything else works");
if (localOriginsInProduction) logger.warn({ origins: env.FRONTEND_ORIGIN }, "production mode with a localhost FRONTEND_ORIGIN: fine for a local run of the build, not for a deployment");

// Open the database connections now, not on the first user's click (each TLS handshake to Neon costs seconds).
const warmStart = Date.now();
warmPool()
  .then(() => logger.info({ connections: env.DATABASE_POOL_MAX, ms: Date.now() - warmStart }, "database pool warmed"))
  .catch((err) => logger.warn({ err }, "database pool warm-up failed; connections will open on demand"));

// Due-date reminders (follow-ups, lead reminders): a first run now, then on their own timer.
startReminders();

// Purge expired sessions, finished password resets and notifications cleared over 30 days ago, hourly.
const purge = setInterval(async () => {
  try {
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
    await prisma.passwordReset.deleteMany({ where: { createdAt: { lt: daysAgo(7) } } });
    await prisma.notification.deleteMany({ where: { deletedAt: { lt: daysAgo(30) } } });
  } catch (err) {
    logger.error({ err }, "purge failed");
  }
}, 60 * 60 * 1000);
purge.unref();

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  clearInterval(purge);
  stopReminders();
  server.close(async () => {
    await notificationsSettled(); // notifications of the last requests are still being saved
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // in-flight requests get 10 s
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
