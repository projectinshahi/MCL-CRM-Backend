import { defineConfig } from "prisma/config";

// Prisma CLI does not read .env itself; Node's built-in loader does it without dotenv.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: rely on the real environment (CI, hosting)
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Migrations need Neon's DIRECT (non-pooled) URL; the app itself uses the pooled DATABASE_URL.
  // DATABASE_UNPOOLED_URL is accepted too (Neon's own name for it).
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_UNPOOLED_URL ?? process.env.DATABASE_URL,
  },
});
