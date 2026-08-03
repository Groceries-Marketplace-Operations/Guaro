ALTER TABLE "auto_fetch_execution"
  ADD COLUMN "requested_brand_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cancelled_brand_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cancel_requested" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "auto_fetch_pool_brand" (
  "id" UUID NOT NULL,
  "pool_id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "manually_included" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auto_fetch_pool_brand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auto_fetch_pool_brand_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "auto_fetch_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "auto_fetch_pool_brand_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "auto_fetch_pool_brand_pool_id_brand_id_key" ON "auto_fetch_pool_brand"("pool_id", "brand_id");
CREATE INDEX "auto_fetch_pool_brand_pool_id_active_idx" ON "auto_fetch_pool_brand"("pool_id", "active");
CREATE INDEX "auto_fetch_pool_brand_brand_id_idx" ON "auto_fetch_pool_brand"("brand_id");
