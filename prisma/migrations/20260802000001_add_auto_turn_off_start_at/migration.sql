ALTER TABLE "auto_turn_off_rule" ADD COLUMN "starts_at" TIMESTAMPTZ;

UPDATE "auto_turn_off_rule"
SET "starts_at" = "next_run_at"
WHERE "starts_at" IS NULL;

ALTER TABLE "auto_turn_off_rule" ALTER COLUMN "starts_at" SET NOT NULL;
