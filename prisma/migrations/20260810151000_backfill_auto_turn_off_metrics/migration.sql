WITH metrics AS (
  SELECT
    "execution_id",
    COUNT(*) FILTER (WHERE "status" = 'done')::integer AS "shops_succeeded",
    COUNT(*) FILTER (WHERE "status" = 'partial_success')::integer AS "shops_partial",
    COUNT(*) FILTER (WHERE "status" NOT IN ('done', 'partial_success'))::integer AS "shops_failed",
    COALESCE(SUM("items_succeeded"), 0)::integer AS "items_succeeded",
    COALESCE(SUM("items_failed"), 0)::integer AS "items_failed"
  FROM "auto_turn_off_shop_execution"
  GROUP BY "execution_id"
)
UPDATE "auto_turn_off_execution" execution
SET
  "shops_succeeded" = metrics."shops_succeeded",
  "shops_partial" = metrics."shops_partial",
  "shops_failed" = metrics."shops_failed",
  "items_turned_off" = metrics."items_succeeded",
  "items_failed" = metrics."items_failed"
FROM metrics
WHERE execution."id" = metrics."execution_id";
