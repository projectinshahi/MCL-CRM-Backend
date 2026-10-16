import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/mailer.ts", () => ({ sendPasswordResetOtp: vi.fn(async () => true) }));

import { sendPasswordResetOtp } from "../../src/lib/mailer.ts";
import { API, app, hasDb, login, makeUser, ORIGIN, PASSWORD, prisma, resetDb } from "../helpers.ts";

const mailed = vi.mocked(sendPasswordResetOtp);
const post = (path: string, body: object) => request(app).post(`${API}${path}`).set("Origin", ORIGIN).send(body);
/** A login (or any POST) as if from `ip`: the API trusts X-Forwarded-For from the local proxy, as in production. */
const postFrom = (ip: string, path: string, body: object) => request(app).post(`${API}${path}`).set("Origin", ORIGIN).set("X-Forwarded-For", ip).send(body);
/** Asks for a code and waits for its email: the API answers before making it, so a real account answers as fast as an unknown one. */
async function requestCode(email: string, mails = 1) {
  expect((await post("/auth/forgot-password", { email })).status).toBe(202);
  await vi.waitFor(() => expect(mailed).toHaveBeenCalledTimes(mails));
  return mailed.mock.calls[mails - 1]![1];
}
const sessionCookie = (res: request.Response) => ([] as string[]).concat(res.headers["set-cookie"] ?? [])[0] ?? "";

describe.skipIf(!hasDb)("login, session and logout", () => {
  beforeEach(resetDb);

  it("issues an HttpOnly, SameSite=Lax session cookie and stores only its hash", async () => {
    const u = await makeUser(["leads"]);
    const res = await post("/auth/login", { email: u.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/^mcl_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Max-Age/); // browser-session cookie unless "remember me"
    expect(res.body.user).toMatchObject({ email: u.email, permissions: ["leads"] });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash/);

    const token = cookie.split(";")[0]!.split("=")[1]!;
    const session = await prisma.session.findFirstOrThrow({ where: { userId: u.user.id } });
    expect(session.tokenHash).not.toBe(token);
  });

  it("remember me keeps the cookie for 30 days", async () => {
    const u = await makeUser(["leads"]);
    const res = await post("/auth/login", { email: u.email, password: PASSWORD, remember: true });
    expect(sessionCookie(res)).toMatch(/Max-Age=2592000/);
  });

  it("answers a wrong password and an unknown email identically", async () => {
    const u = await makeUser(["leads"]);
    const wrong = await post("/auth/login", { email: u.email, password: "nope-nope" });
    const unknown = await post("/auth/login", { email: "ghost@test.local", password: "nope-nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(await prisma.auditLog.count({ where: { action: "login_failed" } })).toBe(2);
  });

  it("refuses inactive accounts", async () => {
    const u = await makeUser(["leads"], { status: "inactive" });
    const res = await post("/auth/login", { email: u.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("requires a session for /me, and logout revokes it server-side", async () => {
    const u = await makeUser(["leads"]);
    expect((await request(app).get(`${API}/auth/me`)).status).toBe(401);

    const res = await post("/auth/login", { email: u.email, password: PASSWORD });
    const cookie = sessionCookie(res).split(";")[0]!;
    const me = await request(app).get(`${API}/auth/me`).set("Cookie", cookie);
    expect(me.body.user).toMatchObject({ email: u.email, initials: expect.any(String) });

    expect((await request(app).post(`${API}/auth/logout`).set("Origin", ORIGIN).set("Cookie", cookie)).status).toBe(204);
    expect((await request(app).get(`${API}/auth/me`).set("Cookie", cookie)).status).toBe(401); // replayed cookie is dead
  });

  it("rotates the session id on login", async () => {
    const u = await makeUser(["leads"]);
    const agent = await login(u.email);
    await agent.post(`${API}/auth/login`).send({ email: u.email, password: PASSWORD });
    expect(await prisma.session.count({ where: { userId: u.user.id } })).toBe(1);
  });

  it("accepts every origin FRONTEND_ORIGIN lists (e.g. the dev server on 3000, or 3001 when 3000 is taken), and only those", async () => {
    const from = (origin: string) => request(app).post(`${API}/auth/login`).set("Origin", origin).send({ email: "nobody@test.local", password: "wrong-wrong" });
    for (const origin of ["http://localhost:3000", "http://localhost:3001"]) expect([origin, (await from(origin)).status]).toEqual([origin, 401]); // reached the password check
    for (const origin of ["http://localhost:3002", "http://localhost:3000.evil.example", "null"]) expect([origin, (await from(origin)).status]).toEqual([origin, 403]);
  });

  it("rejects state-changing requests from another origin", async () => {
    const res = await request(app).post(`${API}/auth/login`).set("Origin", "https://evil.example").send({ email: "a@b.co", password: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ORIGIN_REJECTED");
  });

  it("rate-limits repeated login attempts for one email", async () => {
    const u = await makeUser(["leads"]);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post("/auth/login", { email: u.email, password: "wrong-wrong" })).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("spaces or capitals around the email don't open a new rate-limit bucket for the same account", async () => {
    const u = await makeUser(["leads"]);
    const variants = [u.email, ` ${u.email}`, `${u.email} `, `  ${u.email.toUpperCase()}`, `${u.email}  `, `	${u.email}`];
    const codes = [];
    for (const email of variants) codes.push((await post("/auth/login", { email, password: "wrong-wrong" })).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("ten wrong passwords for one account, from any number of addresses, stop sign-ins to it; other accounts are unaffected", async () => {
    const u = await makeUser(["leads"]);
    const other = await makeUser(["leads"]);
    // Each from its own address, so the per-address limit never applies: only the per-account one can stop them.
    for (let i = 0; i < 10; i++) expect((await postFrom(`10.0.0.${i}`, "/auth/login", { email: u.email, password: "wrong-wrong" })).status).toBe(401);
    expect((await postFrom("10.0.1.1", "/auth/login", { email: u.email, password: PASSWORD })).status).toBe(429); // even the right password
    expect((await postFrom("10.0.1.1", "/auth/login", { email: other.email, password: PASSWORD })).status).toBe(200);
    // Successful sign-ins don't count towards it.
    for (let i = 0; i < 12; i++) expect((await postFrom(`10.0.2.${i}`, "/auth/login", { email: other.email, password: PASSWORD })).status).toBe(200);
  });

  it("returns the report's error shape for malformed JSON", async () => {
    const res = await request(app).post(`${API}/auth/login`).set("Origin", ORIGIN).set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: "MALFORMED_JSON", message: expect.any(String) } });
  });
});

describe.skipIf(!hasDb)("forgot password with OTP", () => {
  beforeEach(async () => {
    await resetDb();
    mailed.mockClear();
  });

  it("request → verify → reset, revoking every old session", async () => {
    const u = await makeUser(["leads"]);
    const oldSession = await login(u.email);

    const otp = await requestCode(u.email);
    expect(otp).toMatch(/^\d{6}$/);
    const row = await prisma.passwordReset.findFirstOrThrow({ where: { userId: u.user.id } });
    expect(row.otpHash).not.toContain(otp); // stored hashed

    const verified = await post("/auth/verify-otp", { email: u.email, otp });
    expect(verified.status).toBe(200);
    const { resetToken } = verified.body;

    expect((await post("/auth/reset-password", { resetToken, password: "Brand-New-Pass-1" })).status).toBe(204);
    expect((await oldSession.get(`${API}/auth/me`)).status).toBe(401);
    expect((await post("/auth/login", { email: u.email, password: PASSWORD })).status).toBe(401);
    expect((await post("/auth/login", { email: u.email, password: "Brand-New-Pass-1" })).status).toBe(200);

    // single use, both steps
    expect((await post("/auth/reset-password", { resetToken, password: "Another-Pass-22" })).body.error.code).toBe("INVALID_RESET_TOKEN");
    expect((await post("/auth/verify-otp", { email: u.email, otp })).body.error.code).toBe("INVALID_OTP");
  });

  it("gives unknown emails the same 202 and sends nothing", async () => {
    const res = await post("/auth/forgot-password", { email: "ghost@test.local" });
    expect(res.status).toBe(202);
    expect(mailed).not.toHaveBeenCalled();
  });

  it("burns the code after 5 wrong attempts", async () => {
    const u = await makeUser(["leads"]);
    const otp = await requestCode(u.email);
    const wrong = otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await post("/auth/verify-otp", { email: u.email, otp: wrong })).status).toBe(400);
    expect((await post("/auth/verify-otp", { email: u.email, otp })).status).toBe(400);
  });

  it("guesses sent in parallel can't go past the 5 attempts", async () => {
    const u = await makeUser(["leads"]);
    const otp = await requestCode(u.email);
    const wrong = otp === "000000" ? "111111" : "000000";
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => postFrom(`10.1.0.${i}`, "/auth/verify-otp", { email: u.email, otp: wrong })));
    expect(res.every((r) => r.status === 400)).toBe(true);
    const row = await prisma.passwordReset.findFirstOrThrow({ where: { userId: u.user.id } });
    expect([row.attempts, row.usedAt !== null]).toEqual([5, true]);
    expect((await post("/auth/verify-otp", { email: u.email, otp })).status).toBe(400); // the right code is spent too
  });

  it("allows a resend only after the 60-second cooldown, and a new code retires the old one", async () => {
    const u = await makeUser(["leads"]);
    const first = await requestCode(u.email);
    await post("/auth/forgot-password", { email: u.email });
    await new Promise((r) => setTimeout(r, 300)); // its (refused) code is made after the answer
    expect(mailed).toHaveBeenCalledTimes(1);

    await prisma.passwordReset.updateMany({ data: { createdAt: new Date(Date.now() - 61_000) } }); // step past the cooldown
    await requestCode(u.email, 2);
    if (first !== mailed.mock.calls[1]![1]) expect((await post("/auth/verify-otp", { email: u.email, otp: first })).status).toBe(400);
  });

  it("will not reset without a verified token", async () => {
    const res = await post("/auth/reset-password", { resetToken: "x".repeat(43), password: "Brand-New-Pass-1" });
    expect(res.status).toBe(400);
  });
});
