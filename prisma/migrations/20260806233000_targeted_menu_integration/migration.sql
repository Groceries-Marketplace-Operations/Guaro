CREATE TABLE "targeted_menu_rule" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "brand_id" UUID NOT NULL,
  "shop_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "upcs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "starts_at" TIMESTAMPTZ NOT NULL,
  "next_run_at" TIMESTAMPTZ,
  "last_run_at" TIMESTAMPTZ,
  "created_by" UUID,
  "updated_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "targeted_menu_rule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "targeted_menu_execution" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "total_shops" INTEGER NOT NULL DEFAULT 0,
  "processed_shops" INTEGER NOT NULL DEFAULT 0,
  "successful_shops" INTEGER NOT NULL DEFAULT 0,
  "failed_shops" INTEGER NOT NULL DEFAULT 0,
  "current_shop_id" TEXT,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  "error_message" TEXT,
  "result" JSONB,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "targeted_menu_execution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "targeted_menu_rule_active_next_run_at_idx" ON "targeted_menu_rule"("active", "next_run_at");
CREATE INDEX "targeted_menu_rule_brand_id_idx" ON "targeted_menu_rule"("brand_id");
CREATE INDEX "targeted_menu_execution_rule_id_created_at_idx" ON "targeted_menu_execution"("rule_id", "created_at");
CREATE INDEX "targeted_menu_execution_status_idx" ON "targeted_menu_execution"("status");

ALTER TABLE "targeted_menu_rule" ADD CONSTRAINT "targeted_menu_rule_brand_id_fkey"
  FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "targeted_menu_rule" ADD CONSTRAINT "targeted_menu_rule_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "targeted_menu_rule" ADD CONSTRAINT "targeted_menu_rule_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "targeted_menu_execution" ADD CONSTRAINT "targeted_menu_execution_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "targeted_menu_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "targeted_menu_execution" ADD CONSTRAINT "targeted_menu_execution_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- This feature now lives in Custom integrations. Keep historical tasks readable,
-- but prevent creation of new task instances from the old Excel-based task type.
UPDATE "task_type"
SET "activo" = false, "deleted_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'b503df86-081a-4a32-8294-3500546892bf';
