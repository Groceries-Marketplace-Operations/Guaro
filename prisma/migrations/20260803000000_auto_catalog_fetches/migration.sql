ALTER TABLE "shop"
  ADD COLUMN "menu_sync_status" TEXT NOT NULL DEFAULT 'never',
  ADD COLUMN "menu_synced_at" TIMESTAMPTZ,
  ADD COLUMN "menu_sync_error" TEXT,
  ADD COLUMN "menu_item_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "brand_item" (
  "id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "upc" TEXT,
  "app_item_id" TEXT NOT NULL,
  "app_shop_id" TEXT NOT NULL,
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_item_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "brand_item_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "brand_item_shop_id_app_item_id_key" ON "brand_item"("shop_id", "app_item_id");
CREATE INDEX "brand_item_brand_id_upc_idx" ON "brand_item"("brand_id", "upc");
CREATE INDEX "brand_item_brand_id_name_idx" ON "brand_item"("brand_id", "name");
CREATE INDEX "brand_item_app_shop_id_idx" ON "brand_item"("app_shop_id");

ALTER TABLE "auto_turn_off_pool" ADD COLUMN "country" "Country";

UPDATE "auto_turn_off_pool" pool
SET "country" = COALESCE(
  (
    SELECT brand."country"
    FROM "auto_turn_off_rule" rule
    JOIN "brand" brand ON brand."id" = rule."brand_id"
    WHERE rule."pool_id" = pool."id"
    ORDER BY rule."created_at"
    LIMIT 1
  ),
  CASE
    WHEN lower(pool."name") LIKE '%colom%' THEN 'CO'::"Country"
    WHEN lower(pool."name") LIKE '%costa%' OR lower(pool."name") LIKE '%cr%' THEN 'CR'::"Country"
    ELSE 'MX'::"Country"
  END
);

ALTER TABLE "auto_turn_off_pool" ALTER COLUMN "country" SET NOT NULL;

CREATE TYPE "AutoFetchKind" AS ENUM ('stores', 'menu');

CREATE TABLE "auto_fetch_pool" (
  "id" UUID NOT NULL,
  "kind" "AutoFetchKind" NOT NULL,
  "country" "Country" NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "execution_hour" INTEGER NOT NULL DEFAULT 2,
  "execution_minute" INTEGER NOT NULL DEFAULT 0,
  "timezone" TEXT NOT NULL,
  "next_run_at" TIMESTAMPTZ NOT NULL,
  "last_run_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auto_fetch_pool_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auto_fetch_pool_hour_check" CHECK ("execution_hour" BETWEEN 0 AND 23),
  CONSTRAINT "auto_fetch_pool_minute_check" CHECK ("execution_minute" BETWEEN 0 AND 59)
);

CREATE UNIQUE INDEX "auto_fetch_pool_kind_country_key" ON "auto_fetch_pool"("kind", "country");
CREATE INDEX "auto_fetch_pool_active_next_run_at_idx" ON "auto_fetch_pool"("active", "next_run_at");

CREATE TABLE "auto_fetch_execution" (
  "id" UUID NOT NULL,
  "pool_id" UUID NOT NULL,
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "trigger" TEXT NOT NULL DEFAULT 'scheduled',
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "total_brands" INTEGER NOT NULL DEFAULT 0,
  "brands_succeeded" INTEGER NOT NULL DEFAULT 0,
  "total_shops" INTEGER NOT NULL DEFAULT 0,
  "total_items" INTEGER NOT NULL DEFAULT 0,
  "progress_percent" INTEGER NOT NULL DEFAULT 0,
  "current_brand" TEXT,
  "error_message" TEXT,
  "logs" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auto_fetch_execution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auto_fetch_execution_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "auto_fetch_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "auto_fetch_execution_pool_id_created_at_idx" ON "auto_fetch_execution"("pool_id", "created_at");
CREATE INDEX "auto_fetch_execution_status_idx" ON "auto_fetch_execution"("status");

INSERT INTO "auto_fetch_pool" (
  "id", "kind", "country", "name", "execution_hour", "execution_minute", "timezone", "next_run_at"
)
VALUES
  (gen_random_uuid(), 'stores', 'MX', 'Mexico KA Stores', 1, 0, 'America/Mexico_City', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  (gen_random_uuid(), 'stores', 'CO', 'Colombia KA Stores', 1, 0, 'America/Bogota', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  (gen_random_uuid(), 'stores', 'CR', 'Costa Rica KA Stores', 1, 0, 'America/Costa_Rica', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  (gen_random_uuid(), 'menu', 'MX', 'Mexico KA Menus', 3, 0, 'America/Mexico_City', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  (gen_random_uuid(), 'menu', 'CO', 'Colombia KA Menus', 3, 0, 'America/Bogota', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  (gen_random_uuid(), 'menu', 'CR', 'Costa Rica KA Menus', 3, 0, 'America/Costa_Rica', CURRENT_TIMESTAMP + INTERVAL '1 day');
