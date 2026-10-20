// Reference data only — no users, no demo records. Safe to re-run: it only adds what is missing.
// Run: npm run db:seed   (then: npm run create-admin)
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { PERMISSIONS } from "../src/lib/permissions.ts";

// Initial lists from the frontend's Settings screens (lib/mock/settings.ts); admins edit them afterwards.
const LEAD_SOURCES = ["Direct Office", "Meta Ads", "B2B", "CO - Courier Team", "Other"];
const LEAD_STATUSES = [
  { name: "New" },
  { name: "Contacted" },
  { name: "Interested" },
  { name: "Proposal" },
  { name: "Converted", isWon: true },
  { name: "Lost", isLost: true },
];

export async function seed(prisma: PrismaClient) {
  for (const p of PERMISSIONS)
    await prisma.permission.upsert({ where: { code: p.code }, update: { label: p.label }, create: p });

  // Lists show in creation order, so give each seeded row its own increasing timestamp.
  const base = Date.now();
  if ((await prisma.leadSource.count()) === 0)
    await prisma.leadSource.createMany({ data: LEAD_SOURCES.map((name, i) => ({ name, createdAt: new Date(base + i) })) });

  if ((await prisma.leadStatus.count()) === 0)
    await prisma.leadStatus.createMany({ data: LEAD_STATUSES.map((s, i) => ({ ...s, sortOrder: i + 1 })) });

  // The Admin role holds every permission. Sales, BDE and others are created in the Roles screen.
  if (!(await prisma.role.findUnique({ where: { name: "Admin" } })))
    await prisma.role.create({
      data: { name: "Admin", permissions: { create: PERMISSIONS.map((p) => ({ permissionCode: p.code })) } },
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The same order as prisma.config.ts: the direct endpoint when there is one (DATABASE_UNPOOLED_URL is Neon's name).
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_UNPOOLED_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL (or DATABASE_UNPOOLED_URL, or DATABASE_URL)");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  await seed(prisma);
  await prisma.$disconnect();
  console.log("Seed complete: permissions, lead sources, lead statuses, Admin role.");
}
