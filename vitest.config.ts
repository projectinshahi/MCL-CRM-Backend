import { defineConfig } from "vitest/config";

// Integration tests need TEST_DATABASE_URL (in .env.test, .env or the environment). That database is WIPED on
// every run — point it at a dedicated Neon test branch, never at real data. Without it only unit tests run.
for (const file of [".env.test", ".env"]) {
  try {
    process.loadEnvFile(file); // never overrides variables already set
  } catch {
    // optional
  }
}
const testDb = process.env.TEST_DATABASE_URL ?? "";
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(testDb);

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      TEST_DATABASE_URL: testDb,
      DATABASE_URL: testDb || "postgres://unused:unused@127.0.0.1:1/unused",
      // The local `prisma dev` server falls over with concurrent connections; Neon is fine with a few.
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? (local ? "1" : "5"),
      FRONTEND_ORIGIN: "http://localhost:3001,http://localhost:3000", // both dev ports: see the origin test in auth.test.ts
      SESSION_SECRET: "test-only-secret-test-only-secret-0000",
      // Tests replace the Cloudinary module (tests/integration/attachments.test.ts); these only switch uploads on,
      // and keep anything that slipped through away from real files.
      CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? "test-cloud",
      CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? "test-key",
      CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET ?? "test-secret",
      CLOUDINARY_FOLDER: "mcl-crm-test",
    },
    globalSetup: testDb ? ["tests/global-setup.ts"] : [],
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false, // one shared test database
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
