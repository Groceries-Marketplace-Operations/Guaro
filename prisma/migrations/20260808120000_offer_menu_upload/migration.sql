CREATE TABLE "offer_menu_upload_rule" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "sftp_application_id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "dry_run" BOOLEAN NOT NULL DEFAULT true,
  "schedule_hours" INTEGER[] NOT NULL DEFAULT ARRAY[10, 20]::INTEGER[],
  "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
  "next_run_at" TIMESTAMPTZ,
  "last_run_at" TIMESTAMPTZ,
  "file_pattern" TEXT NOT NULL DEFAULT 'offer*.csv',
  "delimiter" TEXT NOT NULL DEFAULT ';',
  "category_id_prefix" TEXT NOT NULL DEFAULT 'category',
  "category_name" TEXT NOT NULL DEFAULT 'Despensa',
  "menu_id_prefix" TEXT NOT NULL DEFAULT 'menu',
  "menu_name_prefix" TEXT NOT NULL DEFAULT 'Menu',
  "merge_policy" INTEGER NOT NULL DEFAULT 1,
  "store_concurrency" INTEGER NOT NULL DEFAULT 2,
  "max_items_per_store" INTEGER NOT NULL DEFAULT 20000,
  "max_items_per_category" INTEGER NOT NULL DEFAULT 4999,
  "active_status" INTEGER NOT NULL DEFAULT 1,
  "include_tax_info" BOOLEAN NOT NULL DEFAULT false,
  "tax_type" INTEGER NOT NULL DEFAULT 1,
  "tax_rate" INTEGER NOT NULL DEFAULT 1600,
  "last_source_file" TEXT,
  "last_source_modified_at" TIMESTAMPTZ,
  "last_source_size" BIGINT,
  "created_by" UUID,
  "updated_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "offer_menu_upload_rule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offer_menu_upload_execution" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "force" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "duration_ms" INTEGER,
  "source_file" TEXT,
  "source_modified_at" TIMESTAMPTZ,
  "source_size" BIGINT,
  "total_stores" INTEGER NOT NULL DEFAULT 0,
  "processed_stores" INTEGER NOT NULL DEFAULT 0,
  "successful_stores" INTEGER NOT NULL DEFAULT 0,
  "failed_stores" INTEGER NOT NULL DEFAULT 0,
  "total_items" INTEGER NOT NULL DEFAULT 0,
  "uploaded_items" INTEGER NOT NULL DEFAULT 0,
  "failed_items" INTEGER NOT NULL DEFAULT 0,
  "current_store_id" TEXT,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  "error_message" TEXT,
  "result" JSONB,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offer_menu_upload_execution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "offer_menu_upload_rule_active_next_run_at_idx" ON "offer_menu_upload_rule"("active", "next_run_at");
CREATE INDEX "offer_menu_upload_rule_sftp_application_id_idx" ON "offer_menu_upload_rule"("sftp_application_id");
CREATE INDEX "offer_menu_upload_rule_application_id_idx" ON "offer_menu_upload_rule"("application_id");
CREATE INDEX "offer_menu_upload_execution_rule_id_created_at_idx" ON "offer_menu_upload_execution"("rule_id", "created_at");
CREATE INDEX "offer_menu_upload_execution_status_idx" ON "offer_menu_upload_execution"("status");

ALTER TABLE "offer_menu_upload_rule" ADD CONSTRAINT "offer_menu_upload_rule_sftp_application_id_fkey" FOREIGN KEY ("sftp_application_id") REFERENCES "sftp_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_menu_upload_rule" ADD CONSTRAINT "offer_menu_upload_rule_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_menu_upload_rule" ADD CONSTRAINT "offer_menu_upload_rule_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "offer_menu_upload_rule" ADD CONSTRAINT "offer_menu_upload_rule_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "offer_menu_upload_execution" ADD CONSTRAINT "offer_menu_upload_execution_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "offer_menu_upload_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_menu_upload_execution" ADD CONSTRAINT "offer_menu_upload_execution_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
