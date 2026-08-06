ALTER TABLE "file_integration_rule"
ADD COLUMN "file_state_initialized_at" TIMESTAMPTZ;

CREATE TABLE "file_integration_file_state" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "rule_id" UUID NOT NULL,
  "file_name" TEXT NOT NULL,
  "source_modified_at" TIMESTAMPTZ NOT NULL,
  "file_size" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processing_at" TIMESTAMPTZ,
  "processed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_integration_file_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_integration_file_state_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "file_integration_rule"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "file_integration_file_state_rule_id_file_name_key"
ON "file_integration_file_state"("rule_id", "file_name");

CREATE INDEX "file_integration_file_state_rule_id_status_source_modified_at_idx"
ON "file_integration_file_state"("rule_id", "status", "source_modified_at");

CREATE INDEX "file_integration_file_state_rule_id_last_seen_at_idx"
ON "file_integration_file_state"("rule_id", "last_seen_at");

UPDATE "file_integration_rule"
SET
  "max_files_per_run" = 700,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "kind" = 'price_filter'
  AND "deleted_at" IS NULL
  AND "sftp_application_id" IN (
    SELECT "id"
    FROM "sftp_application"
    WHERE LOWER("name") = 'soriana'
      AND "deleted_at" IS NULL
  );
