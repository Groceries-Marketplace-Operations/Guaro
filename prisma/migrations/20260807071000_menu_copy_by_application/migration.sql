ALTER TABLE "menu_copy_execution"
  ADD COLUMN "source_application_id" UUID,
  ADD COLUMN "target_application_id" UUID;

UPDATE "menu_copy_execution" execution
SET
  "source_application_id" = source_brand."application_id",
  "target_application_id" = target_brand."application_id"
FROM "brand" source_brand, "brand" target_brand
WHERE source_brand."id" = execution."source_brand_id"
  AND target_brand."id" = execution."target_brand_id";

ALTER TABLE "menu_copy_execution"
  ALTER COLUMN "source_application_id" SET NOT NULL,
  ALTER COLUMN "target_application_id" SET NOT NULL;

ALTER TABLE "menu_copy_execution" DROP CONSTRAINT "menu_copy_execution_source_brand_id_fkey";
ALTER TABLE "menu_copy_execution" DROP CONSTRAINT "menu_copy_execution_target_brand_id_fkey";
DROP INDEX "menu_copy_execution_source_brand_id_idx";
DROP INDEX "menu_copy_execution_target_brand_id_idx";

ALTER TABLE "menu_copy_execution"
  DROP COLUMN "source_brand_id",
  DROP COLUMN "target_brand_id";

CREATE INDEX "menu_copy_execution_source_application_id_idx"
  ON "menu_copy_execution"("source_application_id");
CREATE INDEX "menu_copy_execution_target_application_id_idx"
  ON "menu_copy_execution"("target_application_id");

ALTER TABLE "menu_copy_execution" ADD CONSTRAINT "menu_copy_execution_source_application_id_fkey"
  FOREIGN KEY ("source_application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_copy_execution" ADD CONSTRAINT "menu_copy_execution_target_application_id_fkey"
  FOREIGN KEY ("target_application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
