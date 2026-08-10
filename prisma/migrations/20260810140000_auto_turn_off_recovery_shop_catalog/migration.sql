ALTER TABLE "auto_turn_off_execution"
  ADD COLUMN "shops_partial" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "shops_failed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "items_failed" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "brand_shop_item" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "brand_id" UUID NOT NULL,
  "shop_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "upc" TEXT,
  "app_item_id" TEXT NOT NULL,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'menu',
  "last_error" TEXT,
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_shop_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_shop_item_brand_id_fkey"
    FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "brand_shop_item_brand_id_shop_id_app_item_id_key"
  ON "brand_shop_item"("brand_id", "shop_id", "app_item_id");
CREATE INDEX "brand_shop_item_brand_id_shop_id_upc_idx"
  ON "brand_shop_item"("brand_id", "shop_id", "upc");
CREATE INDEX "brand_shop_item_brand_id_upc_available_idx"
  ON "brand_shop_item"("brand_id", "upc", "available");

-- Preserve the exact shop mapping from the menu sample that last supplied each
-- global catalog row. Subsequent menu fetches fill this table per sampled shop.
INSERT INTO "brand_shop_item" (
  "brand_id", "shop_id", "name", "upc", "app_item_id", "available",
  "source", "last_error", "last_seen_at", "created_at", "updated_at"
)
SELECT
  "brand_id", "source_shop_id", "name", "upc", "app_item_id", true,
  'menu', NULL, "last_seen_at", "created_at", "updated_at"
FROM "brand_item"
WHERE "source_shop_id" IS NOT NULL
ON CONFLICT ("brand_id", "shop_id", "app_item_id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "upc" = EXCLUDED."upc",
  "available" = true,
  "source" = 'menu',
  "last_error" = NULL,
  "last_seen_at" = EXCLUDED."last_seen_at",
  "updated_at" = CURRENT_TIMESTAMP;

-- Close executions orphaned by an interrupted worker before enforcing the
-- one-active-execution-per-rule invariant.
CREATE TEMP TABLE "_stale_auto_turn_off" AS
SELECT
  execution."id",
  COUNT(shop."id") FILTER (WHERE shop."status" = 'done')::integer AS "shops_succeeded",
  COUNT(shop."id") FILTER (WHERE shop."status" = 'partial_success')::integer AS "shops_partial",
  COUNT(shop."id") FILTER (WHERE shop."status" NOT IN ('done', 'partial_success'))::integer AS "shops_failed",
  COALESCE(SUM(shop."items_succeeded"), 0)::integer AS "items_succeeded",
  COALESCE(SUM(shop."items_failed"), 0)::integer AS "items_failed"
FROM "auto_turn_off_execution" execution
LEFT JOIN "auto_turn_off_shop_execution" shop ON shop."execution_id" = execution."id"
WHERE execution."status" IN ('pending', 'running')
  AND COALESCE(
    (SELECT MAX(recent_shop."updated_at")
     FROM "auto_turn_off_shop_execution" recent_shop
     WHERE recent_shop."execution_id" = execution."id"),
    execution."started_at",
    execution."created_at"
  ) < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
GROUP BY execution."id";

UPDATE "auto_turn_off_execution" execution
SET
  "status" = CASE
    WHEN stale."items_succeeded" > 0 THEN 'partial_success'::"AutoOpenEstado"
    ELSE 'failed'::"AutoOpenEstado"
  END,
  "current_step" = 'recovered_interrupted',
  "finished_at" = CURRENT_TIMESTAMP,
  "shops_succeeded" = stale."shops_succeeded",
  "shops_partial" = stale."shops_partial",
  "shops_failed" = stale."shops_failed",
  "items_turned_off" = stale."items_succeeded",
  "items_failed" = stale."items_failed",
  "progress_current" = execution."progress_total",
  "progress_percent" = 100,
  "error_message" = 'Recovered interrupted execution after more than 15 minutes without progress'
FROM "_stale_auto_turn_off" stale
WHERE execution."id" = stale."id";

UPDATE "auto_turn_off_shop_execution" shop
SET
  "status" = 'cancelled',
  "current_step" = 'recovered_interrupted',
  "finished_at" = CURRENT_TIMESTAMP,
  "updated_at" = CURRENT_TIMESTAMP
WHERE shop."execution_id" IN (SELECT "id" FROM "_stale_auto_turn_off")
  AND shop."status" IN ('pending', 'running');

DROP TABLE "_stale_auto_turn_off";

-- If a deployment races with the old scheduler, retain the oldest active
-- execution and close any newer duplicate before creating the partial index.
CREATE TEMP TABLE "_duplicate_auto_turn_off" AS
SELECT "id"
FROM (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "rule_id" ORDER BY "created_at", "id") AS "position"
  FROM "auto_turn_off_execution"
  WHERE "status" IN ('pending', 'running')
) ranked
WHERE ranked."position" > 1;

UPDATE "auto_turn_off_shop_execution"
SET
  "status" = 'cancelled',
  "current_step" = 'superseded_duplicate',
  "finished_at" = CURRENT_TIMESTAMP,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "execution_id" IN (SELECT "id" FROM "_duplicate_auto_turn_off")
  AND "status" IN ('pending', 'running');

UPDATE "auto_turn_off_execution"
SET
  "status" = 'cancelled',
  "current_step" = 'superseded_duplicate',
  "finished_at" = CURRENT_TIMESTAMP,
  "progress_current" = "progress_total",
  "progress_percent" = 100,
  "error_message" = 'Superseded duplicate active execution during deployment recovery'
WHERE "id" IN (SELECT "id" FROM "_duplicate_auto_turn_off");

DROP TABLE "_duplicate_auto_turn_off";

CREATE UNIQUE INDEX "auto_turn_off_execution_one_active_per_rule"
  ON "auto_turn_off_execution"("rule_id")
  WHERE "status" IN ('pending', 'running');
