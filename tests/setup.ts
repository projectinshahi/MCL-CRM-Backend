import { afterAll } from "vitest";
import { prisma } from "../src/lib/prisma.ts";

// Close each test file's database connections cleanly; the local `prisma dev` server hangs when they are just dropped.
afterAll(() => prisma.$disconnect());
