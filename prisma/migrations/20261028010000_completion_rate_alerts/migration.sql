ALTER TABLE "brand"
  ADD COLUMN "cr_alerts_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cr_baseline_cancel_rate" DOUBLE PRECISION NOT NULL DEFAULT 10,
  ADD COLUMN "cr_deviation_points" DOUBLE PRECISION NOT NULL DEFAULT 15,
  ADD COLUMN "cr_min_orders" INTEGER NOT NULL DEFAULT 10,
  ADD CONSTRAINT "brand_cr_thresholds_check" CHECK (
    cr_baseline_cancel_rate >= 0 AND cr_baseline_cancel_rate <= 100
    AND cr_deviation_points > 0 AND cr_deviation_points <= 100
    AND cr_baseline_cancel_rate + cr_deviation_points <= 100 AND cr_min_orders >= 4
  );

CREATE TABLE "completion_rate_order" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "order_id" TEXT NOT NULL,
  "app_shop_id" TEXT,
  "didi_shop_id" TEXT,
  "status" INTEGER NOT NULL,
  "created_time" TIMESTAMPTZ,
  "event_time" TIMESTAMPTZ NOT NULL,
  "terminal_time" TIMESTAMPTZ,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "completion_rate_order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "completion_rate_order_application_id_order_id_key" ON "completion_rate_order"("application_id", "order_id");
CREATE INDEX "completion_rate_order_application_id_terminal_time_idx" ON "completion_rate_order"("application_id", "terminal_time");

CREATE TABLE "completion_rate_run" (
  "id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "window_end" TIMESTAMPTZ NOT NULL,
  "completed" INTEGER NOT NULL,
  "cancelled" INTEGER NOT NULL,
  "unknown" INTEGER NOT NULL DEFAULT 0,
  "completion_rate" DOUBLE PRECISION,
  "baseline" DOUBLE PRECISION NOT NULL,
  "deviation" DOUBLE PRECISION NOT NULL,
  "min_orders" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "message" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "sent_at" TIMESTAMPTZ,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "completion_rate_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "completion_rate_run_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "completion_rate_run_brand_id_window_end_key" ON "completion_rate_run"("brand_id", "window_end");
CREATE INDEX "completion_rate_run_status_updated_at_idx" ON "completion_rate_run"("status", "updated_at");
