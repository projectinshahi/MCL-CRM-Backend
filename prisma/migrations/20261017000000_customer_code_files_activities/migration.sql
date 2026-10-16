-- Sprint 3 customers: CU-00001 codes, customer files, customer activity entries, and a database rule that a lead
-- is converted only once. Additive: existing rows are kept (customers get codes in creation order).

-- ---------- Customer codes (CU-00001, CU-00002, …) ----------
-- A sequence, not count+1: concurrent conversions can never get the same number, and a number is never reused
-- (a rolled-back conversion leaves a gap). Padded to 5 digits, growing past CU-99999 without truncating.
CREATE SEQUENCE "customer_code_seq" AS BIGINT START 1;
CREATE FUNCTION next_customer_code() RETURNS TEXT LANGUAGE SQL VOLATILE AS $$
  SELECT 'CU-' || lpad(n::text, greatest(5, length(n::text)), '0') FROM nextval('customer_code_seq') AS n
$$;

ALTER TABLE "customers" ADD COLUMN "code" TEXT;
UPDATE "customers" AS c
SET "code" = 'CU-' || lpad(o.rn::text, greatest(5, length(o.rn::text)), '0')
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "customers") AS o
WHERE c."id" = o."id";
SELECT setval('customer_code_seq', greatest((SELECT count(*) FROM "customers"), 1), (SELECT count(*) FROM "customers") > 0);
ALTER TABLE "customers" ALTER COLUMN "code" SET DEFAULT next_customer_code(), ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- ---------- A lead is converted once: its customer link, once set, never changes ----------
CREATE FUNCTION leads_customer_link_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."customer_id" IS NOT NULL AND NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
    RAISE EXCEPTION 'lead % is already converted', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "leads_customer_link_once" BEFORE UPDATE OF "customer_id" ON "leads"
FOR EACH ROW EXECUTE FUNCTION leads_customer_link_once();

-- ---------- Customer activity entries ----------
-- CreateEnum
CREATE TYPE "CustomerActivityType" AS ENUM ('initial', 'follow_up', 'call');

-- CreateTable
CREATE TABLE "customer_activities" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "CustomerActivityType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_activities_pkey" PRIMARY KEY ("id")
);

-- ---------- Customer files (private Cloudinary assets; metadata here) ----------
-- CreateTable
CREATE TABLE "customer_attachments" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "original_size_bytes" INTEGER,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_attachments_public_id_key" ON "customer_attachments"("public_id");

-- CreateIndex
CREATE INDEX "customer_attachments_customer_id_created_at_idx" ON "customer_attachments"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_activities_customer_id_occurred_at_idx" ON "customer_activities"("customer_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "customer_attachments" ADD CONSTRAINT "customer_attachments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_attachments" ADD CONSTRAINT "customer_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
