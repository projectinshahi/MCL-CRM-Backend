import { hash, verify } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import { Router, type CookieOptions, type Request } from "express";
import { z } from "zod";
import { env } from "../../config/env.ts";
import { audit } from "../../lib/audit.ts";
import { hashOtp, newOtp, newToken, safeEqual, sha256 } from "../../lib/crypto.ts";
import { AppError } from "../../lib/errors.ts";
import { initials } from "../../lib/format.ts";
import { email, password } from "../../lib/http.ts";
import { logger } from "../../lib/logger.ts";
import { sendPasswordResetOtp } from "../../lib/mailer.ts";
import { prisma } from "../../lib/prisma.ts";
import { me, readSessionCookie, requireAuth, SESSION_COOKIE, type AuthContext } from "../../middleware/auth.ts";
import { loginAccountLimiter, loginLimiter, passwordResetLimiter } from "../../middleware/security.ts";

// Session lifetimes proposed in the report (section 9); confirm with the business owner.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Forgot-password OTP rules.
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_PER_HOUR = 5;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

// Verifying against a throwaway hash for unknown emails keeps login timing the same either way.
const dummyHash = await hash(newToken());

const cookieOptions = (maxAge?: number): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  ...(maxAge && { maxAge }),
});

export const toMe = (u: AuthContext["user"], permissions: Iterable<string>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  initials: initials(u.name),
  role: u.role,
  permissions: [...permissions].sort(),
});

export const authRouter = Router();

authRouter.post("/auth/login", loginLimiter, loginAccountLimiter, async (req, res) => {
  const body = z
    .object({ email, password: z.string().min(1, "Required").max(128), remember: z.boolean().optional() })
    .parse(req.body);

  const user = await prisma.user.findUnique({
    where: { email: body.email },
    include: { role: { include: { permissions: true } } },
  });
  const ok = await verify(user?.passwordHash ?? dummyHash, body.password);
  if (!user || !ok) {
    await audit(prisma, { actorId: user?.id ?? null, action: "login_failed", entityType: "user", entityId: user?.id ?? null, after: { email: body.email }, ip: req.ip });
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  if (user.status !== "active") throw new AppError(403, "ACCOUNT_INACTIVE", "This account has been deactivated.");

  // New random id on every login; a session cookie sent with this request is revoked (rotation).
  const token = newToken();
  const ttl = body.remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  const previous = readSessionCookie(req);
  await prisma.$transaction([
    ...(previous ? [prisma.session.deleteMany({ where: { tokenHash: sha256(previous) } })] : []),
    prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + ttl),
        ip: req.ip,
        userAgent: req.get("user-agent")?.slice(0, 300),
      },
    }),
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    audit(prisma, { actorId: user.id, action: "login", entityType: "user", entityId: user.id, ip: req.ip }),
  ]);

  res.cookie(SESSION_COOKIE, token, cookieOptions(body.remember ? ttl : undefined));
  res.json({
    user: toMe(
      { id: user.id, name: user.name, email: user.email, phone: user.phone, role: { id: user.role.id, name: user.role.name } },
      user.role.permissions.map((p) => p.permissionCode),
    ),
  });
});

authRouter.post("/auth/logout", requireAuth, async (req, res) => {
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { id: req.auth!.sessionId } }),
    audit(prisma, { actorId: me(req).id, action: "logout", entityType: "user", entityId: me(req).id, ip: req.ip }),
  ]);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.status(204).end();
});

authRouter.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: toMe(me(req), req.auth!.permissions) });
});

// ---------- Forgot password: email → 6-digit OTP → verify → reset token → new password ----------

async function issueOtp(userId: string, to: string, req: Request) {
  const recent = await prisma.passwordReset.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const coolingDown = recent[0] && Date.now() - recent[0].createdAt.getTime() < OTP_RESEND_COOLDOWN_MS;
  if (coolingDown || recent.length >= OTP_MAX_PER_HOUR) return; // silently: the response is the same generic 202

  const id = randomUUID();
  const otp = newOtp();
  await prisma.$transaction([
    // Requesting a new code retires every earlier one.
    prisma.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordReset.create({ data: { id, userId, otpHash: hashOtp(otp, id), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS) } }),
    audit(prisma, { actorId: userId, action: "password_reset_requested", entityType: "user", entityId: userId, ip: req.ip }),
  ]);
  // Not awaited: an existing account must not answer slower than an unknown one.
  sendPasswordResetOtp(to, otp).catch((err: Error) => logger.error({ event: "otp_email_failed", message: err.message }, "OTP email failed"));
}

authRouter.post("/auth/forgot-password", passwordResetLimiter, async (req, res) => {
  const body = z.object({ email }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true, status: true } });
  // Not awaited: a real account's code (several writes) must not make its answer slower than an unknown email's,
  // which would tell anyone which addresses have accounts.
  if (user?.status === "active") issueOtp(user.id, body.email, req).catch((err: Error) => logger.error({ event: "otp_issue_failed", message: err.message }, "OTP not issued"));
  res.status(202).json({});
});

const invalidOtp = () => new AppError(400, "INVALID_OTP", "The code is invalid or has expired.");

authRouter.post("/auth/verify-otp", passwordResetLimiter, async (req, res) => {
  const body = z.object({ email, otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true, status: true } });
  if (user?.status !== "active") throw invalidOtp();

  const reset = await prisma.passwordReset.findFirst({
    where: { userId: user.id, usedAt: null, verifiedAt: null, otpExpiresAt: { gt: new Date() }, attempts: { lt: OTP_MAX_ATTEMPTS } },
    orderBy: { createdAt: "desc" },
  });
  if (!reset) throw invalidOtp();

  // The attempt is taken before the code is compared, in one conditional update: guesses sent in parallel can't
  // all use the same remaining attempts (reading, comparing, then counting let every parallel guess through).
  const turn = await prisma.passwordReset.updateMany({
    where: { id: reset.id, usedAt: null, verifiedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (turn.count !== 1) throw invalidOtp();
  if (!safeEqual(hashOtp(body.otp, reset.id), reset.otpHash)) {
    // The last attempt is gone: the code is spent.
    await prisma.passwordReset.updateMany({ where: { id: reset.id, usedAt: null, attempts: { gte: OTP_MAX_ATTEMPTS } }, data: { usedAt: new Date() } });
    throw invalidOtp();
  }

  const resetToken = newToken();
  const claimed = await prisma.passwordReset.updateMany({
    where: { id: reset.id, verifiedAt: null, usedAt: null },
    data: { verifiedAt: new Date(), resetTokenHash: sha256(resetToken), resetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });
  if (claimed.count !== 1) throw invalidOtp();
  res.json({ resetToken });
});

authRouter.post("/auth/reset-password", passwordResetLimiter, async (req, res) => {
  const body = z.object({ resetToken: z.string().min(20).max(200), password }).parse(req.body);
  const invalidToken = () => new AppError(400, "INVALID_RESET_TOKEN", "This reset session is invalid or has expired. Request a new code.");

  const reset = await prisma.passwordReset.findUnique({
    where: { resetTokenHash: sha256(body.resetToken) },
    include: { user: { select: { status: true } } },
  });
  if (!reset?.verifiedAt || reset.usedAt || !reset.resetExpiresAt || reset.resetExpiresAt <= new Date() || reset.user.status !== "active")
    throw invalidToken();

  const passwordHash = await hash(body.password);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: new Date() } });
    if (count !== 1) throw invalidToken();
    await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: reset.userId } }); // every device signs in again
    await audit(tx, { actorId: reset.userId, action: "password_reset_completed", entityType: "user", entityId: reset.userId, ip: req.ip });
  });
  res.status(204).end();
});
