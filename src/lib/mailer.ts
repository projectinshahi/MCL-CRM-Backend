import nodemailer from "nodemailer";
import { emailConfigured, env } from "../config/env.ts";
import { logger } from "./logger.ts";

const transport = emailConfigured ? nodemailer.createTransport(env.SMTP_URL!) : null;

/** Resolves false when SMTP is not configured: callers must not claim the email went out. */
// ponytail: one send attempt; add a queue with retries if SMTP delivery proves flaky
export async function sendPasswordResetOtp(to: string, otp: string): Promise<boolean> {
  if (!transport) {
    logger.warn({ event: "email_not_configured" }, "Password reset code not emailed: SMTP_URL / EMAIL_FROM are not set");
    return false;
  }
  await transport.sendMail({
    from: env.EMAIL_FROM,
    to,
    subject: "Your MCL CRM password reset code",
    text:
      `Your MCL CRM password reset code is ${otp}.\n\n` +
      "It expires in 10 minutes and can be used once. If you did not ask to reset your password, ignore this email.",
  });
  return true;
}
