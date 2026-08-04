CREATE TABLE "forced_open_operation" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "requested_shop_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total_shops" INTEGER NOT NULL DEFAULT 0,
    "shops_opened" INTEGER NOT NULL DEFAULT 0,
    "shops_failed" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "forced_open_operation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "forced_open_target" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "opened_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "forced_open_target_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "forced_open_operation_brand_id_created_at_idx" ON "forced_open_operation"("brand_id", "created_at");
CREATE INDEX "forced_open_operation_status_created_at_idx" ON "forced_open_operation"("status", "created_at");
CREATE UNIQUE INDEX "forced_open_target_operation_id_shop_id_key" ON "forced_open_target"("operation_id", "shop_id");
CREATE INDEX "forced_open_target_operation_id_status_idx" ON "forced_open_target"("operation_id", "status");

ALTER TABLE "forced_open_operation" ADD CONSTRAINT "forced_open_operation_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forced_open_operation" ADD CONSTRAINT "forced_open_operation_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forced_open_target" ADD CONSTRAINT "forced_open_target_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "forced_open_operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "forced_open_target" ADD CONSTRAINT "forced_open_target_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
