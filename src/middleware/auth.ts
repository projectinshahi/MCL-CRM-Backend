import type { Request, RequestHandler } from "express";
import { sha256 } from "../lib/crypto.ts";
import { AppError } from "../lib/errors.ts";
import type { PermissionCode } from "../lib/permissions.ts";
import { prisma } from "../lib/prisma.ts";

export const SESSION_COOKIE = "mcl_session";

export type AuthContext = {
  sessionId: string;
  user: { id: string; name: string; email: string; phone: string | null; role: { id: string; name: string } };
  permissions: Set<string>;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function readSessionCookie(req: Request): string | undefined {
  for (const part of req.headers.cookie?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
}

// Resolves the session cookie on every API request. Permissions are read fresh each time,
// so a role change or deactivation applies on the user's very next request.
export const loadSession: RequestHandler = async (req, _res, next) => {
  const token = readSessionCookie(req);
  // Only something shaped like newToken() (32 random bytes, base64url) is looked up: this runs before the rate
  // limiters, so random cookies must not each cost a database query.
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { role: { include: { permissions: true } } } } },
    });
    if (session && session.expiresAt > new Date() && session.user.status === "active") {
      const { user } = session;
      req.auth = {
        sessionId: session.id,
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: { id: user.role.id, name: user.role.name } },
        permissions: new Set(user.role.permissions.map((p) => p.permissionCode)),
      };
    }
  }
  next();
};

const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");

export const requireAuth: RequestHandler = (req, _res, next) => next(req.auth ? undefined : unauthenticated());

/** Passes when the user holds ANY of the listed page permissions. */
export const requirePermission =
  (...codes: PermissionCode[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    if (!codes.some((c) => req.auth!.permissions.has(c)))
      return next(new AppError(403, "FORBIDDEN", "You do not have permission to do this."));
    next();
  };

/** The signed-in user; only call behind requireAuth / requirePermission. */
export const me = (req: Request) => req.auth!.user;

/** Q12 decision: without "all_records" a user only sees records they own or are assigned to. */
export const seesAll = (req: Request) => req.auth!.permissions.has("all_records");
