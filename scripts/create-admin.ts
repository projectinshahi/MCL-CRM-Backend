// One-time bootstrap of the first administrator. There is no public sign-up endpoint.
//
//   ADMIN_NAME="Full Name" ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='long secret' npm run create-admin
//
// Re-running is safe: once any active user holds the Users permission it does nothing.
// Clear ADMIN_PASSWORD from your shell afterwards; later users are created from the Users screen.
import { hash } from "@node-rs/argon2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const name = process.env.ADMIN_NAME?.trim();
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "";
const url = process.env.DIRECT_URL ?? process.env.DATABASE_UNPOOLED_URL ?? process.env.DATABASE_URL; // as prisma.config.ts

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!url) fail("Set DATABASE_URL (or DIRECT_URL) in .env first.");
if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Set ADMIN_NAME and a valid ADMIN_EMAIL.");
if (password.length < 12) fail("ADMIN_PASSWORD must be at least 12 characters.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const admins = await prisma.user.count({
    where: { status: "active", role: { permissions: { some: { permissionCode: "users" } } } },
  });
  if (admins > 0) {
    console.log("An active administrator already exists. Nothing changed.");
  } else {
    const role = await prisma.role.findUnique({ where: { name: "Admin" } });
    if (!role) fail('The "Admin" role is missing. Run `npm run db:seed` first.');
    if (await prisma.user.findUnique({ where: { email } })) fail("A user with that email already exists.");
    const user = await prisma.user.create({ data: { name, email, roleId: role.id, passwordHash: await hash(password) } });
    await prisma.auditLog.create({ data: { actorId: null, action: "admin_bootstrapped", entityType: "user", entityId: user.id } });
    console.log(`Administrator created for ${email}.`);
  }
} finally {
  await prisma.$disconnect();
}
