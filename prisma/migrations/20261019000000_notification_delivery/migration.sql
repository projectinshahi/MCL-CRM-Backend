-- Notifications start being made (src/lib/notify.ts, src/modules/notifications/reminders.ts). Additive only: two
-- nullable columns and two indexes; no existing row is changed or removed.
--  - dedupe_key: the event a notification reports; (user_id, dedupe_key) is unique, so a retried request, a repeated
--    reminder run or a second API instance can never notify the same person twice (NULLs never conflict).
--  - deleted_at: cleared by its reader. The row is kept for a while so a cleared reminder is not made again.
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" TEXT,
ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");
