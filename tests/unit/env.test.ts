import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.ts";

const SECRET = "s3cret-value-that-must-never-be-printed-0000";
const base = { NODE_ENV: "development", DATABASE_URL: "postgresql://app:db-pass-123@db.example.com/app", FRONTEND_ORIGIN: "http://localhost:3000", SESSION_SECRET: SECRET };
const problems = (over: Record<string, string | undefined>) => {
  try {
    loadEnv({ ...base, ...over });
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("environment configuration", () => {
  it("reads TRUST_PROXY as Express needs it: false by default, booleans, hop counts, address lists", () => {
    expect(loadEnv(base).TRUST_PROXY).toBe(false);
    // As plain strings, "false"/"true" made Express refuse to start ("invalid IP address: false").
    expect([loadEnv({ ...base, TRUST_PROXY: "false" }).TRUST_PROXY, loadEnv({ ...base, TRUST_PROXY: "true" }).TRUST_PROXY]).toEqual([false, true]);
    expect(loadEnv({ ...base, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
    expect(loadEnv({ ...base, TRUST_PROXY: "loopback" }).TRUST_PROXY).toBe("loopback");
  });

  it("keeps FRONTEND_ORIGIN as bare origins: a trailing slash or space must not refuse every save", () => {
    expect(loadEnv({ ...base, FRONTEND_ORIGIN: " https://crm.example.com/ , http://localhost:3001" }).FRONTEND_ORIGIN).toEqual(["https://crm.example.com", "http://localhost:3001"]);
  });

  it("lists every missing or malformed variable by name, without printing any value", () => {
    const message = problems({ DATABASE_URL: "mysql://app:db-pass-123@db.example.com/app", SESSION_SECRET: undefined, FRONTEND_ORIGIN: "not a url" });
    expect(message).toMatch(/DATABASE_URL: must be a postgres/);
    expect(message).toMatch(/SESSION_SECRET/);
    expect(message).toMatch(/FRONTEND_ORIGIN/);
    expect(message).not.toMatch(/db-pass-123|mysql:/);
  });

  it("refuses a half-configured email or file-storage service instead of silently switching it off", () => {
    expect(problems({ SMTP_URL: "smtps://u:p@smtp.example.com" })).toMatch(/SMTP_URL and EMAIL_FROM: set both/);
    expect(problems({ CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "123" })).toMatch(/set all three/);
    expect(problems({ SMTP_URL: "smtps://u:p@smtp.example.com", EMAIL_FROM: "MCL <crm@example.com>" })).toBe("");
  });

  it("production: https origins only (Secure cookies), except this machine for a local run; never the test suite's secret", () => {
    const prod = { NODE_ENV: "production" };
    expect(problems({ ...prod, FRONTEND_ORIGIN: "http://crm.example.com" })).toMatch(/FRONTEND_ORIGIN: http:\/\/crm\.example\.com must use https/);
    expect(problems({ ...prod, FRONTEND_ORIGIN: "https://crm.example.com" })).toBe("");
    expect(problems({ ...prod, FRONTEND_ORIGIN: "http://localhost:3000" })).toBe("");
    expect(problems({ ...prod, SESSION_SECRET: "test-only-secret-test-only-secret-0000" })).toMatch(/SESSION_SECRET: the test suite's value/);
    expect(problems({ ...prod, FRONTEND_ORIGIN: "http://crm.example.com" })).not.toContain(SECRET);
  });
});
