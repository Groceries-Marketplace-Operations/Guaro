CREATE TABLE "upc_activity_price_rule" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "application_id" UUID NOT NULL,
    "shop_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "target_upc" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "schedule_hours" INTEGER[] NOT NULL DEFAULT ARRAY[8, 9, 10, 11, 12, 13],
    "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "next_run_at" TIMESTAMPTZ,
    "last_run_at" TIMESTAMPTZ,
    "store_concurrency" INTEGER NOT NULL DEFAULT 2,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    CONSTRAINT "upc_activity_price_rule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "upc_activity_price_execution" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "duration_ms" INTEGER,
    "total_shops" INTEGER NOT NULL DEFAULT 0,
    "processed_shops" INTEGER NOT NULL DEFAULT 0,
    "successful_shops" INTEGER NOT NULL DEFAULT 0,
    "skipped_shops" INTEGER NOT NULL DEFAULT 0,
    "failed_shops" INTEGER NOT NULL DEFAULT 0,
    "current_shop_id" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "result" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "upc_activity_price_execution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "upc_activity_price_rule_active_next_run_at_idx" ON "upc_activity_price_rule"("active", "next_run_at");
CREATE INDEX "upc_activity_price_rule_application_id_idx" ON "upc_activity_price_rule"("application_id");
CREATE INDEX "upc_activity_price_execution_rule_id_created_at_idx" ON "upc_activity_price_execution"("rule_id", "created_at");
CREATE INDEX "upc_activity_price_execution_status_idx" ON "upc_activity_price_execution"("status");

ALTER TABLE "upc_activity_price_rule" ADD CONSTRAINT "upc_activity_price_rule_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upc_activity_price_rule" ADD CONSTRAINT "upc_activity_price_rule_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "upc_activity_price_rule" ADD CONSTRAINT "upc_activity_price_rule_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "upc_activity_price_execution" ADD CONSTRAINT "upc_activity_price_execution_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "upc_activity_price_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upc_activity_price_execution" ADD CONSTRAINT "upc_activity_price_execution_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
