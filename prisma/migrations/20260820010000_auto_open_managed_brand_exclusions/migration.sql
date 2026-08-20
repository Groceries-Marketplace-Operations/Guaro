BEGIN;

CREATE TABLE "auto_open_pool_brand_exclusion" (
  "pool_id" UUID NOT NULL,
  "brand_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auto_open_pool_brand_exclusion_pkey" PRIMARY KEY ("pool_id", "brand_id"),
  CONSTRAINT "auto_open_pool_brand_exclusion_pool_id_fkey"
    FOREIGN KEY ("pool_id") REFERENCES "auto_open_pool"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "auto_open_pool_brand_exclusion_brand_id_fkey"
    FOREIGN KEY ("brand_id") REFERENCES "brand"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "auto_open_pool_brand_exclusion_brand_id_idx"
  ON "auto_open_pool_brand_exclusion"("brand_id");

COMMIT;
