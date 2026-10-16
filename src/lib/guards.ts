import type { Prisma } from "../generated/prisma/client.ts";
import { AppError } from "./errors.ts";

// Run inside the same (serializable) transaction as the change being checked.
export async function assertAdminRemains(tx: Prisma.TransactionClient) {
  const admins = await tx.user.count({
    where: { status: "active", role: { permissions: { some: { permissionCode: "users" } } } },
  });
  if (admins === 0)
    throw new AppError(409, "LAST_ADMIN", "At least one active user must keep the Users permission.");
}
