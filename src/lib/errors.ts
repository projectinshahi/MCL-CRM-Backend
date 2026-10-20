export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found.`);

export const invalid = (fields: Record<string, string>) =>
  new AppError(422, "VALIDATION_FAILED", "The submitted data is invalid.", fields);

type DbError = { code?: string; meta?: { driverAdapterError?: { cause?: { kind?: string } } } } | null;
/** What refused a raw statement (P2010), as the driver adapter names it. */
const rawKind = (e: unknown) => ((e as DbError)?.code === "P2010" ? (e as DbError)!.meta?.driverAdapterError?.cause?.kind : undefined);

/** A unique constraint refused the write: P2002 from Prisma's own queries, or inside P2010 from a raw statement. */
export const isUniqueViolation = (e: unknown) => (e as DbError)?.code === "P2002" || rawKind(e) === "UniqueConstraintViolation";

/** A raw write named a row that no longer exists (removed between the route's checks and the write). */
export const isMissingReference = (e: unknown) => rawKind(e) === "ForeignKeyConstraintViolation";
