ALTER TABLE "auto_turn_off_rule"
    ADD COLUMN "ends_at" TIMESTAMPTZ,
    ADD COLUMN "created_by_id" UUID,
    ADD COLUMN "updated_by_id" UUID;

WITH fallback_account AS (
    SELECT "id"
    FROM "account"
    ORDER BY
        CASE WHEN 'super_admin'::"AccountRol" = ANY("roles") THEN 0 ELSE 1 END,
        "created_at" ASC
    LIMIT 1
)
UPDATE "auto_turn_off_rule" AS rule
SET "created_by_id" = fallback_account."id",
    "updated_by_id" = fallback_account."id"
FROM fallback_account
WHERE rule."created_by_id" IS NULL OR rule."updated_by_id" IS NULL;

ALTER TABLE "auto_turn_off_rule"
    ALTER COLUMN "created_by_id" SET NOT NULL,
    ALTER COLUMN "updated_by_id" SET NOT NULL;

ALTER TABLE "auto_turn_off_rule"
    ADD CONSTRAINT "auto_turn_off_rule_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "auto_turn_off_rule_updated_by_id_fkey"
        FOREIGN KEY ("updated_by_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "auto_turn_off_rule_ends_at_idx" ON "auto_turn_off_rule"("ends_at");

ALTER TABLE "auto_turn_off_execution"
    ADD COLUMN "current_step" TEXT,
    ADD COLUMN "progress_current" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "progress_total" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "progress_percent" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "error_message" TEXT;
