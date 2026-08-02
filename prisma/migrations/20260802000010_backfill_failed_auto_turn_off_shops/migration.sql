INSERT INTO "auto_turn_off_shop_execution" (
  "id",
  "execution_id",
  "shop_id",
  "status",
  "current_step",
  "items_succeeded",
  "items_failed",
  "result",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  execution."id",
  target."shop_id",
  'failed',
  'failed',
  0,
  cardinality(rule."upcs"),
  jsonb_build_object(
    'shopId', target."shop_id",
    'appShopId', '-',
    'endpoint', rule."stock_endpoint",
    'success', false,
    'itemsSucceeded', 0,
    'itemsFailed', cardinality(rule."upcs"),
    'requestedUpcs', cardinality(rule."upcs"),
    'error', execution."error_message"
  ),
  execution."started_at",
  execution."finished_at",
  COALESCE(execution."started_at", execution."created_at"),
  COALESCE(execution."finished_at", now())
FROM "auto_turn_off_execution" execution
JOIN "auto_turn_off_rule" rule ON rule."id" = execution."rule_id"
CROSS JOIN LATERAL unnest(rule."shop_ids") AS target("shop_id")
WHERE execution."status" = 'failed'
  AND NOT EXISTS (
    SELECT 1
    FROM "auto_turn_off_shop_execution" existing
    WHERE existing."execution_id" = execution."id"
  )
ON CONFLICT ("execution_id", "shop_id") DO NOTHING;

UPDATE "auto_turn_off_execution" execution
SET "total_shops" = cardinality(rule."shop_ids")
FROM "auto_turn_off_rule" rule
WHERE rule."id" = execution."rule_id"
  AND execution."status" = 'failed'
  AND execution."total_shops" = 0;
