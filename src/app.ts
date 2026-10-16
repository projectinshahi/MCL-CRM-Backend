import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.ts";
import { logger } from "./lib/logger.ts";
import { prisma } from "./lib/prisma.ts";
import { loadSession } from "./middleware/auth.ts";
import { errorHandler, notFoundRoute } from "./middleware/error-handler.ts";
import { apiLimiter, originCheck } from "./middleware/security.ts";
import { authRouter } from "./modules/auth/routes.ts";
import { customersRouter } from "./modules/customers/routes.ts";
import { dashboardRouter } from "./modules/dashboard/routes.ts";
import { followUpsRouter } from "./modules/follow-ups/routes.ts";
import { leadsRouter } from "./modules/leads/routes.ts";
import { notificationsRouter } from "./modules/notifications/routes.ts";
import { rolesRouter } from "./modules/roles/routes.ts";
import { settingsRouter } from "./modules/settings/routes.ts";
import { usersRouter } from "./modules/users/routes.ts";

export function createApp() {
  const app = express();
  // Behind the Next.js /api proxy (and any load balancer): needed for the real client IP in rate limits and logs.
  app.set("trust proxy", /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/healthz" },
    }),
  );

  // Liveness: the process is up. Readiness: it can also reach PostgreSQL.
  app.get("/healthz", (_req, res) => void res.json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  const api = express.Router();
  // Answers carry one user's records: never stored by the browser or any cache in between (a shared computer keeps
  // nobody's data, and a role change is never hidden behind a cached copy).
  const noStore: express.RequestHandler = (_req, res, next) => (res.set("Cache-Control", "no-store"), next());
  api.use(noStore, apiLimiter, express.json({ limit: "100kb" }), originCheck, loadSession);
  api.use(authRouter, usersRouter, rolesRouter, settingsRouter, leadsRouter, followUpsRouter, customersRouter, dashboardRouter, notificationsRouter);
  app.use("/api/v1", api);

  app.use(notFoundRoute);
  app.use(errorHandler);
  return app;
}
