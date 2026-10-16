import type { Prisma } from "../generated/prisma/client.ts";
import type { prisma } from "./prisma.ts";

type Db = Pick<typeof prisma, "auditLog"> | Prisma.TransactionClient;

export type AuditEntry = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
};

// Append-only. Callers pass plain field snapshots — never password hashes, OTPs or tokens.
export const audit = (db: Db, entry: AuditEntry) => db.auditLog.create({ data: entry });
