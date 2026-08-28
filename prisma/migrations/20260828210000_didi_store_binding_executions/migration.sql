CREATE TYPE "DidiStoreBindingAction" AS ENUM ('bind', 'unbind');
CREATE TYPE "DidiStoreBindingItemStatus" AS ENUM (
  'pending',
  'processing',
  'submitting',
  'success',
  'failed',
  'unconfirmed',
  'cancelled'
);

CREATE TABLE "didi_store_binding_execution" (
  "id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "application_snapshot_fingerprint" TEXT NOT NULL,
  "application_app_id_snapshot" TEXT NOT NULL,
  "application_id" UUID NOT NULL,
  "action" "DidiStoreBindingAction" NOT NULL,
  "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
  "environment" "DidiBindingEnvironment" NOT NULL,
  "total_shops" INTEGER NOT NULL DEFAULT 0,
  "processed_shops" INTEGER NOT NULL DEFAULT 0,
  "successful_shops" INTEGER NOT NULL DEFAULT 0,
  "failed_shops" INTEGER NOT NULL DEFAULT 0,
  "unconfirmed_shops" INTEGER NOT NULL DEFAULT 0,
  "current_shop_id" TEXT,
  "current_batch" INTEGER,
  "total_batches" INTEGER NOT NULL DEFAULT 0,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "batch_fingerprint" TEXT,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "didi_store_binding_execution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "didi_store_binding_execution_item" (
  "id" UUID NOT NULL,
  "execution_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "shop_id" TEXT NOT NULL,
  "app_shop_id" TEXT NOT NULL,
  "remote_page_no" INTEGER,
  "status" "DidiStoreBindingItemStatus" NOT NULL DEFAULT 'pending',
  "message" TEXT,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "didi_store_binding_execution_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "didi_store_binding_execution_application_id_created_at_idx"
ON "didi_store_binding_execution"("application_id", "created_at");
CREATE UNIQUE INDEX "didi_store_binding_execution_idempotency_key_key"
ON "didi_store_binding_execution"("idempotency_key");
CREATE INDEX "didi_store_binding_execution_status_idx"
ON "didi_store_binding_execution"("status");
CREATE UNIQUE INDEX "didi_store_binding_execution_one_active_per_application_idx"
ON "didi_store_binding_execution"("application_id")
WHERE "status" IN ('pending'::"AutoOpenEstado", 'running'::"AutoOpenEstado");

CREATE UNIQUE INDEX "didi_store_binding_execution_item_execution_id_ordinal_key"
ON "didi_store_binding_execution_item"("execution_id", "ordinal");
CREATE UNIQUE INDEX "didi_store_binding_execution_item_execution_id_shop_id_key"
ON "didi_store_binding_execution_item"("execution_id", "shop_id");
CREATE UNIQUE INDEX "didi_store_binding_execution_item_execution_id_app_shop_id_key"
ON "didi_store_binding_execution_item"("execution_id", "app_shop_id");
CREATE INDEX "didi_store_binding_execution_item_execution_id_status_ordinal_idx"
ON "didi_store_binding_execution_item"("execution_id", "status", "ordinal");

ALTER TABLE "didi_store_binding_execution"
ADD CONSTRAINT "didi_store_binding_execution_application_id_fkey"
FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "didi_store_binding_execution"
ADD CONSTRAINT "didi_store_binding_execution_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "didi_store_binding_execution_item"
ADD CONSTRAINT "didi_store_binding_execution_item_execution_id_fkey"
FOREIGN KEY ("execution_id") REFERENCES "didi_store_binding_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
