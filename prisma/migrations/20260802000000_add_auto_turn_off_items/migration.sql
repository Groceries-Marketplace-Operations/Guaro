CREATE TABLE "auto_turn_off_pool" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "webhook_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "auto_turn_off_pool_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auto_turn_off_rule" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "interval_minutes" INTEGER NOT NULL,
    "upcs" TEXT[],
    "next_run_at" TIMESTAMPTZ NOT NULL,
    "last_run_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "auto_turn_off_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auto_turn_off_rule_interval_check" CHECK ("interval_minutes" >= 10),
    CONSTRAINT "auto_turn_off_rule_upcs_check" CHECK (cardinality("upcs") > 0)
);

CREATE TABLE "auto_turn_off_rule_shop" (
    "rule_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,

    CONSTRAINT "auto_turn_off_rule_shop_pkey" PRIMARY KEY ("rule_id", "shop_id")
);

CREATE TABLE "auto_turn_off_execution" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
    "trigger" TEXT NOT NULL DEFAULT 'scheduled',
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "total_shops" INTEGER NOT NULL DEFAULT 0,
    "shops_succeeded" INTEGER NOT NULL DEFAULT 0,
    "items_turned_off" INTEGER NOT NULL DEFAULT 0,
    "logs" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_turn_off_execution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auto_turn_off_rule_pool_id_idx" ON "auto_turn_off_rule"("pool_id");
CREATE INDEX "auto_turn_off_rule_brand_id_idx" ON "auto_turn_off_rule"("brand_id");
CREATE INDEX "auto_turn_off_rule_active_next_run_at_idx" ON "auto_turn_off_rule"("active", "next_run_at");
CREATE INDEX "auto_turn_off_rule_shop_shop_id_idx" ON "auto_turn_off_rule_shop"("shop_id");
CREATE INDEX "auto_turn_off_execution_pool_id_idx" ON "auto_turn_off_execution"("pool_id");
CREATE INDEX "auto_turn_off_execution_rule_id_idx" ON "auto_turn_off_execution"("rule_id");
CREATE INDEX "auto_turn_off_execution_created_at_idx" ON "auto_turn_off_execution"("created_at");

ALTER TABLE "auto_turn_off_pool" ADD CONSTRAINT "auto_turn_off_pool_webhook_id_fkey"
    FOREIGN KEY ("webhook_id") REFERENCES "webhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auto_turn_off_rule" ADD CONSTRAINT "auto_turn_off_rule_pool_id_fkey"
    FOREIGN KEY ("pool_id") REFERENCES "auto_turn_off_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_turn_off_rule" ADD CONSTRAINT "auto_turn_off_rule_brand_id_fkey"
    FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_turn_off_rule_shop" ADD CONSTRAINT "auto_turn_off_rule_shop_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "auto_turn_off_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_turn_off_rule_shop" ADD CONSTRAINT "auto_turn_off_rule_shop_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_turn_off_execution" ADD CONSTRAINT "auto_turn_off_execution_pool_id_fkey"
    FOREIGN KEY ("pool_id") REFERENCES "auto_turn_off_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_turn_off_execution" ADD CONSTRAINT "auto_turn_off_execution_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "auto_turn_off_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
