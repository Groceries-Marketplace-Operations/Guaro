ALTER TABLE "shop" ADD COLUMN "address" TEXT;

ALTER TABLE "brand_item"
  ADD COLUMN "source_shop_id" TEXT,
  ADD COLUMN "source_city" TEXT;

UPDATE "brand_item" item
SET "source_shop_id" = shop."shop_id",
    "source_city" = shop."city"
FROM "shop" shop
WHERE shop."id" = item."shop_id";

DELETE FROM "brand_item" older
USING "brand_item" newer
WHERE older."brand_id" = newer."brand_id"
  AND older."app_item_id" = newer."app_item_id"
  AND (
    older."last_seen_at" < newer."last_seen_at"
    OR (older."last_seen_at" = newer."last_seen_at" AND older."id"::text > newer."id"::text)
  );

DROP INDEX "brand_item_shop_id_app_item_id_key";
DROP INDEX "brand_item_app_shop_id_idx";
ALTER TABLE "brand_item" DROP CONSTRAINT "brand_item_shop_id_fkey";
ALTER TABLE "brand_item" DROP COLUMN "shop_id", DROP COLUMN "app_shop_id";
CREATE UNIQUE INDEX "brand_item_brand_id_app_item_id_key" ON "brand_item"("brand_id", "app_item_id");

CREATE TABLE "sftp_application" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 22,
  "username" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "root_path" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "sftp_application_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sftp_application_port_check" CHECK ("port" BETWEEN 1 AND 65535),
  CONSTRAINT "sftp_application_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "sftp_application_active_idx" ON "sftp_application"("active");

CREATE TABLE "store_emergency" (
  "id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "mode" TEXT NOT NULL,
  "requested_shop_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ends_at" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_by_id" UUID NOT NULL,
  "started_at" TIMESTAMPTZ,
  "offline_at" TIMESTAMPTZ,
  "restored_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_emergency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_emergency_mode_check" CHECK ("mode" IN ('all_brand', 'shop_list')),
  CONSTRAINT "store_emergency_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "store_emergency_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "store_emergency_brand_id_created_at_idx" ON "store_emergency"("brand_id", "created_at");
CREATE INDEX "store_emergency_status_ends_at_idx" ON "store_emergency"("status", "ends_at");

CREATE TABLE "store_emergency_target" (
  "id" UUID NOT NULL,
  "emergency_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "offline_status" TEXT NOT NULL DEFAULT 'pending',
  "restore_status" TEXT NOT NULL DEFAULT 'pending',
  "offline_error" TEXT,
  "restore_error" TEXT,
  "offline_at" TIMESTAMPTZ,
  "restored_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_emergency_target_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_emergency_target_emergency_id_fkey" FOREIGN KEY ("emergency_id") REFERENCES "store_emergency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "store_emergency_target_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "store_emergency_target_emergency_id_shop_id_key" ON "store_emergency_target"("emergency_id", "shop_id");
CREATE INDEX "store_emergency_target_emergency_id_offline_status_idx" ON "store_emergency_target"("emergency_id", "offline_status");
CREATE INDEX "store_emergency_target_emergency_id_restore_status_idx" ON "store_emergency_target"("emergency_id", "restore_status");
