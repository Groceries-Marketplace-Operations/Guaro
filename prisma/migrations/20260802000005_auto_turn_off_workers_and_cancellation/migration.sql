ALTER TYPE "AutoOpenEstado" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "auto_turn_off_execution"
    ADD COLUMN "cancelled_by_id" UUID,
    ADD COLUMN "cancelled_at" TIMESTAMPTZ;

ALTER TABLE "auto_turn_off_execution"
    ADD CONSTRAINT "auto_turn_off_execution_cancelled_by_id_fkey"
        FOREIGN KEY ("cancelled_by_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "auto_turn_off_shop_execution" (
    "id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "shop_id" TEXT NOT NULL,
    "app_shop_id" TEXT,
    "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
    "current_step" TEXT,
    "items_succeeded" INTEGER NOT NULL DEFAULT 0,
    "items_failed" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "auto_turn_off_shop_execution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auto_turn_off_shop_execution_execution_id_fkey"
        FOREIGN KEY ("execution_id") REFERENCES "auto_turn_off_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "auto_turn_off_shop_execution_execution_id_shop_id_key"
    ON "auto_turn_off_shop_execution"("execution_id", "shop_id");

CREATE INDEX "auto_turn_off_shop_execution_execution_id_status_idx"
    ON "auto_turn_off_shop_execution"("execution_id", "status");
