-- Shipment Type: free text → Air / Water.
-- Converted in place (prisma migrate diff proposed DROP + ADD COLUMN, which would lose existing values):
-- 'Air', 'AIR', ' water ' … keep their meaning, blank becomes NULL (as the API already stores blanks), and any other
-- value makes this statement fail so the whole migration rolls back instead of silently changing a record.
CREATE TYPE "ShipmentType" AS ENUM ('air', 'water');

ALTER TABLE "leads"
  ALTER COLUMN "shipment_type" TYPE "ShipmentType"
  USING NULLIF(lower(btrim("shipment_type")), '')::"ShipmentType";

-- Lead attachments: metadata only; the files are private Cloudinary assets.
CREATE TABLE "lead_attachments" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "original_size_bytes" INTEGER,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_attachments_public_id_key" ON "lead_attachments"("public_id");

CREATE INDEX "lead_attachments_lead_id_created_at_idx" ON "lead_attachments"("lead_id", "created_at");

ALTER TABLE "lead_attachments" ADD CONSTRAINT "lead_attachments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lead_attachments" ADD CONSTRAINT "lead_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
