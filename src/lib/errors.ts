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

/** A unique constraint refused the write: P2002 from Prisma's own queries, or inside P2010 from a raw statement. */
export const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; meta?: { driverAdapterError?: { cause?: { kind?: string } } } } | null;
  return err?.code === "P2002" || (err?.code === "P2010" && err.meta?.driverAdapterError?.cause?.kind === "UniqueConstraintViolation");
};
