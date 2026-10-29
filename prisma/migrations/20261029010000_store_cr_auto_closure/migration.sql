-- AlterTable
ALTER TABLE "brand" ADD COLUMN     "cr_auto_closure_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cr_auto_closure_min_orders" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "cr_auto_closure_threshold" DOUBLE PRECISION NOT NULL DEFAULT 50;
ALTER TABLE "brand" ADD CONSTRAINT "brand_cr_auto_closure_config_check"
  CHECK ("cr_auto_closure_threshold" >= 0 AND "cr_auto_closure_threshold" <= 100 AND "cr_auto_closure_min_orders" >= 1);

-- AlterTable
ALTER TABLE "auto_open_execution" ADD COLUMN     "shops_skipped_cr_closure" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "auto_open_brand_execution" ADD COLUMN     "shops_skipped_cr_closure" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "store_cr_decision" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "completed" INTEGER NOT NULL,
    "cancelled" INTEGER NOT NULL,
    "unknown" INTEGER NOT NULL,
    "completion_rate" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION NOT NULL,
    "min_orders" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "order_ids" JSONB NOT NULL,

    CONSTRAINT "store_cr_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_cr_closure" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "app_shop_id" TEXT NOT NULL,
    "brand_name" TEXT NOT NULL,
    "shop_name" TEXT NOT NULL,
    "operational_start" TIMESTAMPTZ NOT NULL,
    "blocked_until" TIMESTAMPTZ NOT NULL,
    "evaluated_at" TIMESTAMPTZ NOT NULL,
    "completion_rate" DOUBLE PRECISION NOT NULL,
    "completed" INTEGER NOT NULL,
    "cancelled" INTEGER NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "min_orders" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "closed_at" TIMESTAMPTZ,
    "notification_status" TEXT NOT NULL DEFAULT 'waiting',
    "notification_attempts" INTEGER NOT NULL DEFAULT 0,
    "notification_updated_at" TIMESTAMPTZ,
    "notified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_cr_closure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_cr_decision_brand_id_window_end_idx" ON "store_cr_decision"("brand_id", "window_end");

-- CreateIndex
CREATE UNIQUE INDEX "store_cr_decision_shop_id_window_end_key" ON "store_cr_decision"("shop_id", "window_end");

-- CreateIndex
CREATE INDEX "store_cr_closure_brand_id_created_at_idx" ON "store_cr_closure"("brand_id", "created_at");

-- CreateIndex
CREATE INDEX "store_cr_closure_shop_id_blocked_until_idx" ON "store_cr_closure"("shop_id", "blocked_until");

-- CreateIndex
CREATE INDEX "store_cr_closure_status_updated_at_idx" ON "store_cr_closure"("status", "updated_at");

-- CreateIndex
CREATE INDEX "store_cr_closure_notification_status_notification_updated_a_idx" ON "store_cr_closure"("notification_status", "notification_updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_cr_closure_shop_id_operational_start_key" ON "store_cr_closure"("shop_id", "operational_start");

-- AddForeignKey
ALTER TABLE "store_cr_decision" ADD CONSTRAINT "store_cr_decision_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_cr_decision" ADD CONSTRAINT "store_cr_decision_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_cr_closure" ADD CONSTRAINT "store_cr_closure_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_cr_closure" ADD CONSTRAINT "store_cr_closure_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
