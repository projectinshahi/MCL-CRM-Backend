import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { Prisma } from "../../src/generated/prisma/client.ts";
import { AppError } from "../../src/lib/errors.ts";
import { email, money, optText, weightKg } from "../../src/lib/http.ts";
import { toAppError } from "../../src/middleware/error-handler.ts";

describe("field schemas", () => {
  it("money accepts rupees with up to 2 decimals as an exact string", () => {
    expect(money.parse(249000)).toBe("249000");
    expect(money.parse("249000.55")).toBe("249000.55");
    for (const bad of [-1, "1.234", "abc", 1e21]) expect(money.safeParse(bad).success).toBe(false);
  });
  it("weight accepts up to 3 decimals", () => {
    expect(weightKg.parse("1.500")).toBe("1.500");
    expect(weightKg.safeParse("1.5005").success).toBe(false);
  });
  it("email is trimmed and lower-cased", () => {
    expect(email.parse("  Praveen@Example.COM ")).toBe("praveen@example.com");
    expect(email.safeParse("not-an-email").success).toBe(false);
  });
  it("blank optional text becomes null", () => {
    expect(optText(10).parse("   ")).toBeNull();
    expect(optText(10).parse(undefined)).toBeUndefined();
  });
});

describe("error mapping", () => {
  it("turns Zod errors into the report's 422 shape with per-field messages", () => {
    const err = z.object({ email }).safeParse({ email: "x" }).error as ZodError;
    const e = toAppError(err);
    expect(e.status).toBe(422);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.fields).toHaveProperty("email");
  });
  it("maps malformed JSON to 400 and unknown errors to a generic 500", () => {
    expect(toAppError({ type: "entity.parse.failed" }).status).toBe(400);
    const e = toAppError(new Error("SELECT * FROM secrets"));
    expect(e.status).toBe(500);
    expect(e.message).not.toContain("SELECT");
  });
  it("maps a timed-out database transaction (P2028) to a retryable 503, not a 500", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Unable to start a transaction in the given time.", { code: "P2028", clientVersion: "test" });
    const e = toAppError(err);
    expect(e.status).toBe(503);
    expect(e.code).toBe("DB_TIMEOUT");
  });
  it("maps an unreachable or dropped database connection to a retryable 503 with a plain message", () => {
    for (const code of ["P1001", "P1017", "P2024"]) {
      const e = toAppError(new Prisma.PrismaClientKnownRequestError("Server has closed the connection.", { code, clientVersion: "test" }));
      expect([e.status, e.code]).toEqual([503, "DB_UNAVAILABLE"]);
      expect(e.message).not.toMatch(/closed the connection|P1/);
    }
  });
  it("passes AppErrors through", () => {
    expect(toAppError(new AppError(409, "X", "y")).code).toBe("X");
  });
});
