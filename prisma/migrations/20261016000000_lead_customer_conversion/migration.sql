-- Lead → customer conversion. Additive only: new nullable columns, an index and a foreign key; nothing is dropped
-- or rewritten, so the previous API version keeps working against this schema.

-- Customer details a lead already collects but customers had no place for.
ALTER TABLE "customers" ADD COLUMN     "company_email" TEXT,
ADD COLUMN     "company_location" TEXT,
ADD COLUMN     "district" TEXT;

-- The customer a lead was converted into (many leads → one customer), and when.
ALTER TABLE "leads" ADD COLUMN     "converted_at" TIMESTAMPTZ(3),
ADD COLUMN     "customer_id" UUID;

-- Customers already created from a lead (customers.lead_id) become that lead's customer, so both links agree.
UPDATE "leads" AS l
SET "customer_id" = c."id", "converted_at" = c."created_at"
FROM "customers" AS c
WHERE c."lead_id" = l."id" AND l."customer_id" IS NULL;

-- CreateIndex
CREATE INDEX "leads_customer_id_idx" ON "leads"("customer_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
