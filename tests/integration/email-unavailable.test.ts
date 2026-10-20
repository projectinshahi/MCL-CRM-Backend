import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// No SMTP_URL / EMAIL_FROM on the server. Answered before any database work, so this runs without a test database.
vi.mock("../../src/config/env.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/config/env.ts")>()), emailConfigured: false }));

import { API, app, ORIGIN } from "../helpers.ts";

describe("forgot password without an email service", () => {
  it("says it is unavailable — the same for every address — instead of claiming a code was sent", async () => {
    const answers = await Promise.all(
      ["someone@test.local", "nobody-at-all@test.local"].map((email) => request(app).post(`${API}/auth/forgot-password`).set("Origin", ORIGIN).send({ email })),
    );
    for (const res of answers) {
      expect(res.status).toBe(503);
      expect(res.body.error).toEqual({ code: "EMAIL_UNAVAILABLE", message: expect.stringMatching(/Ask an administrator/) });
    }
  });
});
