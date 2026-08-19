BEGIN;

ALTER TABLE "auto_open_execution"
  ADD COLUMN IF NOT EXISTS "shops_failed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "total_brands" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "brands_completed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "brands_failed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "progress_percent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "current_brand" TEXT,
  ADD COLUMN IF NOT EXISTS "error_message" TEXT,
  ADD COLUMN IF NOT EXISTS "heartbeat_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "auto_open_brand_execution" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "execution_id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "brand_name" TEXT NOT NULL,
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "total_shops" INTEGER NOT NULL DEFAULT 0,
  "shops_processed" INTEGER NOT NULL DEFAULT 0,
  "shops_opened" INTEGER NOT NULL DEFAULT 0,
  "shops_would_open" INTEGER NOT NULL DEFAULT 0,
  "shops_skipped_emergency" INTEGER NOT NULL DEFAULT 0,
  "shops_failed" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "shop_errors" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auto_open_brand_execution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auto_open_brand_execution_execution_id_fkey"
    FOREIGN KEY ("execution_id") REFERENCES "auto_open_execution"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "auto_open_brand_execution_execution_id_brand_id_key"
  ON "auto_open_brand_execution"("execution_id", "brand_id");

CREATE INDEX IF NOT EXISTS "auto_open_brand_execution_execution_id_status_idx"
  ON "auto_open_brand_execution"("execution_id", "status");

CREATE INDEX IF NOT EXISTS "auto_open_brand_execution_status_updated_at_idx"
  ON "auto_open_brand_execution"("status", "updated_at");

CREATE INDEX IF NOT EXISTS "auto_open_execution_status_heartbeat_at_idx"
  ON "auto_open_execution"("status", "heartbeat_at");

COMMIT;
