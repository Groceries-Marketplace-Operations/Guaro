BEGIN;

ALTER TABLE "auto_open_pool"
  ADD COLUMN IF NOT EXISTS "managed_key" TEXT,
  ADD COLUMN IF NOT EXISTS "dry_run" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "auto_open_pool" ALTER COLUMN "active" SET DEFAULT FALSE;

ALTER TABLE "auto_open_execution"
  ADD COLUMN IF NOT EXISTS "dry_run" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "remote_writes_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "scheduled_slot" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "shops_would_open" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "shops_skipped_emergency" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "auto_open_pool_managed_key_key"
  ON "auto_open_pool"("managed_key");

CREATE UNIQUE INDEX IF NOT EXISTS "auto_open_execution_pool_id_scheduled_slot_key"
  ON "auto_open_execution"("pool_id", "scheduled_slot");

COMMIT;
