CREATE TABLE "massive_rtbo_execution" (
    "id" UUID NOT NULL,
    "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
    "application_id" UUID NOT NULL,
    "shop_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "promise_produce_time" INTEGER NOT NULL,
    "total_shops" INTEGER NOT NULL DEFAULT 0,
    "processed_shops" INTEGER NOT NULL DEFAULT 0,
    "successful_shops" INTEGER NOT NULL DEFAULT 0,
    "failed_shops" INTEGER NOT NULL DEFAULT 0,
    "current_shop_id" TEXT,
    "current_step" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "result" JSONB,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "massive_rtbo_execution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "massive_rtbo_execution_application_id_created_at_idx"
ON "massive_rtbo_execution"("application_id", "created_at");

CREATE INDEX "massive_rtbo_execution_status_idx"
ON "massive_rtbo_execution"("status");

ALTER TABLE "massive_rtbo_execution"
ADD CONSTRAINT "massive_rtbo_execution_application_id_fkey"
FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "massive_rtbo_execution"
ADD CONSTRAINT "massive_rtbo_execution_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
