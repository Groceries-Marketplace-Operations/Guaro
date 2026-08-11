ALTER TABLE "file_integration_rule"
  ADD COLUMN "upc_column" INTEGER,
  ADD COLUMN "excluded_upcs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "file_integration_rule"
  ADD CONSTRAINT "file_integration_rule_upc_column_check"
  CHECK ("upc_column" IS NULL OR "upc_column" BETWEEN 0 AND 200);

ALTER TABLE "store_emergency"
  ADD COLUMN "reason" VARCHAR(500) NOT NULL DEFAULT 'Emergency store shutdown';

ALTER TABLE "store_emergency"
  ALTER COLUMN "reason" DROP DEFAULT;
