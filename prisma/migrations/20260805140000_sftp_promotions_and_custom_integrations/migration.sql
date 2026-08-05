CREATE TYPE "FileIntegrationKind" AS ENUM ('complex_promotion_reader', 'price_filter');
CREATE TYPE "PromotionApiMode" AS ENUM ('dry_run', 'live');

CREATE TABLE "file_integration_rule" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "FileIntegrationKind" NOT NULL,
  "country" "Country",
  "sftp_application_id" UUID NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "interval_minutes" INTEGER,
  "next_run_at" TIMESTAMPTZ,
  "last_run_at" TIMESTAMPTZ,
  "last_remote_modified_at" TIMESTAMPTZ,
  "file_pattern" TEXT NOT NULL DEFAULT '*',
  "source_scope" TEXT NOT NULL DEFAULT 'all',
  "threshold_amount" DECIMAL(14,2),
  "delimiter" TEXT,
  "price_column" INTEGER,
  "max_files_per_run" INTEGER NOT NULL DEFAULT 250,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "file_integration_rule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "file_integration_execution" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "duration_ms" INTEGER,
  "files_scanned" INTEGER NOT NULL DEFAULT 0,
  "files_processed" INTEGER NOT NULL DEFAULT 0,
  "rows_read" INTEGER NOT NULL DEFAULT 0,
  "rows_kept" INTEGER NOT NULL DEFAULT 0,
  "rows_removed" INTEGER NOT NULL DEFAULT 0,
  "bytes_read" BIGINT NOT NULL DEFAULT 0,
  "current_file" TEXT,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  "error_message" TEXT,
  "result" JSONB,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_integration_execution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "promotion_api_execution" (
  "id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "mode" "PromotionApiMode" NOT NULL DEFAULT 'dry_run',
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "endpoint" TEXT NOT NULL DEFAULT 'POST /v1/promo/promo/uploadGrocery',
  "payload" JSONB NOT NULL,
  "response" JSONB,
  "remote_task_id" TEXT,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "duration_ms" INTEGER,
  "error_message" TEXT,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promotion_api_execution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "file_integration_rule_kind_active_next_run_at_idx" ON "file_integration_rule"("kind", "active", "next_run_at");
CREATE INDEX "file_integration_rule_sftp_application_id_idx" ON "file_integration_rule"("sftp_application_id");
CREATE INDEX "file_integration_execution_rule_id_created_at_idx" ON "file_integration_execution"("rule_id", "created_at");
CREATE INDEX "file_integration_execution_status_idx" ON "file_integration_execution"("status");
CREATE INDEX "promotion_api_execution_brand_id_created_at_idx" ON "promotion_api_execution"("brand_id", "created_at");
CREATE INDEX "promotion_api_execution_shop_id_idx" ON "promotion_api_execution"("shop_id");
CREATE INDEX "promotion_api_execution_status_idx" ON "promotion_api_execution"("status");

ALTER TABLE "file_integration_rule" ADD CONSTRAINT "file_integration_rule_sftp_application_id_fkey" FOREIGN KEY ("sftp_application_id") REFERENCES "sftp_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_integration_rule" ADD CONSTRAINT "file_integration_rule_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "file_integration_execution" ADD CONSTRAINT "file_integration_execution_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "file_integration_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_integration_execution" ADD CONSTRAINT "file_integration_execution_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "promotion_api_execution" ADD CONSTRAINT "promotion_api_execution_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_api_execution" ADD CONSTRAINT "promotion_api_execution_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_api_execution" ADD CONSTRAINT "promotion_api_execution_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
