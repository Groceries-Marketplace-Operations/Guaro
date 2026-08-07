CREATE TABLE "menu_copy_execution" (
  "id" UUID NOT NULL,
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "source_brand_id" UUID NOT NULL,
  "target_brand_id" UUID NOT NULL,
  "source_shop_id" TEXT NOT NULL,
  "target_shop_id" TEXT NOT NULL,
  "source_app_shop_id" TEXT,
  "target_app_shop_id" TEXT,
  "merge_policy" INTEGER NOT NULL DEFAULT 0,
  "current_step" TEXT,
  "export_task_id" TEXT,
  "upload_task_id" TEXT,
  "item_count" INTEGER NOT NULL DEFAULT 0,
  "category_count" INTEGER NOT NULL DEFAULT 0,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "menu_copy_execution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "menu_copy_execution_created_at_idx" ON "menu_copy_execution"("created_at");
CREATE INDEX "menu_copy_execution_status_idx" ON "menu_copy_execution"("status");
CREATE INDEX "menu_copy_execution_source_brand_id_idx" ON "menu_copy_execution"("source_brand_id");
CREATE INDEX "menu_copy_execution_target_brand_id_idx" ON "menu_copy_execution"("target_brand_id");

ALTER TABLE "menu_copy_execution" ADD CONSTRAINT "menu_copy_execution_source_brand_id_fkey"
  FOREIGN KEY ("source_brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_copy_execution" ADD CONSTRAINT "menu_copy_execution_target_brand_id_fkey"
  FOREIGN KEY ("target_brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_copy_execution" ADD CONSTRAINT "menu_copy_execution_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
