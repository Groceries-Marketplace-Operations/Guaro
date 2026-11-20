ALTER TABLE "file_integration_rule"
ADD COLUMN "filter_mode" TEXT NOT NULL DEFAULT 'amount';

-- The old price filter removed selected codes before applying its amount
-- threshold. Preserve that behaviour for already configured rules.
UPDATE "file_integration_rule"
SET "filter_mode" = 'amount_and_code'
WHERE "kind" = 'price_filter'
  AND cardinality("excluded_upcs") > 0;

ALTER TABLE "file_integration_rule"
ADD CONSTRAINT "file_integration_rule_filter_mode_check"
CHECK ("filter_mode" IN ('amount', 'code', 'amount_and_code'));
