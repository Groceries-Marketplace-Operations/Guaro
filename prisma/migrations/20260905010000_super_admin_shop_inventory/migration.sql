CREATE TYPE "ApplicationShopInventoryFetchStatus" AS ENUM (
  'never',
  'queued',
  'running',
  'succeeded',
  'failed'
);

CREATE TABLE "application_shop_inventory" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "last_requested_by_id" UUID,
  "fetch_status" "ApplicationShopInventoryFetchStatus" NOT NULL DEFAULT 'never',
  "active_run_id" UUID,
  "fetch_requested_at" TIMESTAMPTZ,
  "fetch_started_at" TIMESTAMPTZ,
  "fetch_finished_at" TIMESTAMPTZ,
  "fetch_pages_processed" INTEGER NOT NULL DEFAULT 0,
  "fetch_shops_discovered" INTEGER NOT NULL DEFAULT 0,
  "fetch_expected_shops" INTEGER,
  "last_successful_fetch_at" TIMESTAMPTZ,
  "total_shops" INTEGER NOT NULL DEFAULT 0,
  "identified_brand_shops" INTEGER NOT NULL DEFAULT 0,
  "total_brands" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "application_shop_inventory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_shop_inventory_shop" (
  "id" UUID NOT NULL,
  "inventory_id" UUID NOT NULL,
  "shop_id" TEXT NOT NULL,
  "app_shop_id" TEXT NOT NULL,
  "shop_name" TEXT,
  "brand_external_id" TEXT,
  "brand_name" TEXT,
  "brand_source" TEXT,
  "city" TEXT,
  "address" TEXT,
  "fetched_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "application_shop_inventory_shop_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "application_shop_inventory_application_id_key"
  ON "application_shop_inventory"("application_id");
CREATE INDEX "application_shop_inventory_fetch_status_fetch_requested_at_idx"
  ON "application_shop_inventory"("fetch_status", "fetch_requested_at");

CREATE UNIQUE INDEX "application_shop_inventory_shop_inventory_id_shop_id_key"
  ON "application_shop_inventory_shop"("inventory_id", "shop_id");
CREATE UNIQUE INDEX "application_shop_inventory_shop_inventory_id_app_shop_id_key"
  ON "application_shop_inventory_shop"("inventory_id", "app_shop_id");
CREATE INDEX "application_shop_inventory_shop_inventory_id_brand_external_id_idx"
  ON "application_shop_inventory_shop"("inventory_id", "brand_external_id");
CREATE INDEX "application_shop_inventory_shop_inventory_id_brand_name_idx"
  ON "application_shop_inventory_shop"("inventory_id", "brand_name");
CREATE INDEX "application_shop_inventory_shop_inventory_id_shop_name_idx"
  ON "application_shop_inventory_shop"("inventory_id", "shop_name");

ALTER TABLE "application_shop_inventory"
  ADD CONSTRAINT "application_shop_inventory_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "application"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_shop_inventory"
  ADD CONSTRAINT "application_shop_inventory_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "application_shop_inventory"
  ADD CONSTRAINT "application_shop_inventory_last_requested_by_id_fkey"
  FOREIGN KEY ("last_requested_by_id") REFERENCES "account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "application_shop_inventory_shop"
  ADD CONSTRAINT "application_shop_inventory_shop_inventory_id_fkey"
  FOREIGN KEY ("inventory_id") REFERENCES "application_shop_inventory"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
