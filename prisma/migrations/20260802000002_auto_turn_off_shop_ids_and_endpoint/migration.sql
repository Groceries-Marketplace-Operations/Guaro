ALTER TABLE "auto_turn_off_rule"
    ADD COLUMN "shop_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "stock_endpoint" TEXT NOT NULL DEFAULT 'setStock';

UPDATE "auto_turn_off_rule" AS rule
SET "shop_ids" = migrated."shop_ids"
FROM (
    SELECT rule_shop."rule_id", array_agg(shop."shop_id" ORDER BY shop."shop_id") AS "shop_ids"
    FROM "auto_turn_off_rule_shop" AS rule_shop
    INNER JOIN "shop" AS shop ON shop."id" = rule_shop."shop_id"
    GROUP BY rule_shop."rule_id"
) AS migrated
WHERE migrated."rule_id" = rule."id";

ALTER TABLE "auto_turn_off_rule"
    ALTER COLUMN "shop_ids" DROP DEFAULT;

ALTER TABLE "auto_turn_off_rule"
    DROP CONSTRAINT "auto_turn_off_rule_interval_check";

ALTER TABLE "auto_turn_off_rule"
    ADD CONSTRAINT "auto_turn_off_rule_interval_check" CHECK ("interval_minutes" >= 1),
    ADD CONSTRAINT "auto_turn_off_rule_shop_ids_check" CHECK (cardinality("shop_ids") > 0),
    ADD CONSTRAINT "auto_turn_off_rule_stock_endpoint_check"
        CHECK ("stock_endpoint" IN ('setStock', 'setstockSync'));

CREATE INDEX "auto_turn_off_rule_shop_ids_idx" ON "auto_turn_off_rule" USING GIN ("shop_ids");

DROP TABLE "auto_turn_off_rule_shop";
