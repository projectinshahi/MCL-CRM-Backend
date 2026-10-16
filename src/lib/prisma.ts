import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { env } from "../config/env.ts";
import { PrismaClient } from "../generated/prisma/client.ts";
import { logger } from "./logger.ts";

// node-postgres over Neon's pooled endpoint (PgBouncer, transaction mode); TLS comes from sslmode=require in the URL.
//
// Opening a TLS connection to Neon is the most expensive thing this API does: 2.5–4.4 s measured from India to
// us-east-2, versus ~0.3 s for a query on an open connection. So connections are opened once and kept:
//  - idleTimeoutMillis 0: never close idle connections (node-postgres' default closed them after 10 s, so the first
//    click after filling in a form paid a fresh handshake);
//  - keepAlive: TCP keep-alive stops NATs from silently dropping the idle sockets;
//  - warmPool(): opens every connection at startup, so parallel queries never wait for a new one.
// A connection the server closes while idle (Neon suspending its compute, a network blip) is discarded by the pool
// and reopened on the next query. The pool reports it as an 'error' event, which Node treats as fatal unless
// something listens — it used to stop the whole API.
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 0,
  keepAlive: true,
});
pool.on("error", (err) => logger.warn({ reason: err.message }, "idle database connection closed; it will be reopened when needed"));

// Interactive transactions (role / user edits) make several round trips, and a single round trip to Neon
// occasionally spikes past 1–2 s. Prisma's defaults (2 s to start, 5 s to finish) then abort a healthy save (P2028).
export const prisma = new PrismaClient({
  adapter: new PrismaPg(pool, { disposeExternalPool: true }), // $disconnect() (shutdown, tests) closes these connections cleanly
  transactionOptions: { maxWait: 10_000, timeout: 20_000 },
});

/** Opens all pool connections in parallel and keeps them idle in the pool. Safe to call at any time. */
export async function warmPool() {
  const clients = await Promise.all(Array.from({ length: env.DATABASE_POOL_MAX }, () => pool.connect()));
  for (const c of clients) c.release();
}
