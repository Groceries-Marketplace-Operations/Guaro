BEGIN;
ALTER TABLE "sftp_api_rule" ADD COLUMN "max_file_age_minutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "sftp_api_rule" ADD CONSTRAINT "sftp_api_rule_file_age_check" CHECK ("max_file_age_minutes" BETWEEN 1 AND 525600);
CREATE TABLE "sftp_api_processed_file" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "file_name" TEXT NOT NULL,
  "modified_at" TIMESTAMPTZ,
  "file_hash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ,
  CONSTRAINT "sftp_api_processed_file_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sftp_api_processed_file_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "sftp_api_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sftp_api_processed_file_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sftp_api_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sftp_api_processed_file_rule_id_file_name_key" ON "sftp_api_processed_file"("rule_id", "file_name");
CREATE INDEX "sftp_api_processed_file_rule_id_created_at_idx" ON "sftp_api_processed_file"("rule_id", "created_at");
CREATE INDEX "sftp_api_processed_file_run_id_status_idx" ON "sftp_api_processed_file"("run_id", "status");

-- Preserve filename deduplication for files with existing send reports.
WITH reports AS (
  SELECT r."rule_id", u."run_id", u."file_name", MAX(u."sent_at") AS last_sent,
    MAX(u."file_hash") AS file_hash,
    CASE WHEN BOOL_OR(u."status" IN ('sending', 'unknown')) THEN 'needs_review'
      WHEN BOOL_AND(u."status" IN ('accepted', 'succeeded')) THEN 'processed'
      ELSE 'partial_failure' END AS status
  FROM "sftp_api_upload" u JOIN "sftp_api_run" r ON r."id" = u."run_id"
  GROUP BY r."rule_id", u."run_id", u."file_name"
), latest AS (
  SELECT DISTINCT ON (rule_id, file_name) * FROM reports ORDER BY rule_id, file_name, last_sent DESC, run_id
)
INSERT INTO "sftp_api_processed_file" ("id", "rule_id", "run_id", "file_name", "file_hash", "status", "created_at", "processed_at")
SELECT gen_random_uuid(), rule_id, run_id, file_name, file_hash, status, last_sent, last_sent FROM latest;
COMMIT;
