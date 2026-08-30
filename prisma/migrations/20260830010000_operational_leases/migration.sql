ALTER TABLE "upc_activity_price_execution"
  ADD COLUMN "manual_review_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manual_review_reason" TEXT;

-- Released rows are intentionally retained. Re-acquisition increments the
-- persisted fencing token, so a stale owner can never become current again.
CREATE TABLE "operational_lease" (
  "resource_key" TEXT NOT NULL,
  "owner_token" UUID,
  "owner_kind" TEXT,
  "owner_id" TEXT,
  "fencing_token" BIGINT NOT NULL DEFAULT 0,
  "acquired_at" TIMESTAMPTZ,
  "heartbeat_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "operational_lease_pkey" PRIMARY KEY ("resource_key"),
  CONSTRAINT "operational_lease_fencing_token_nonnegative"
    CHECK ("fencing_token" >= 0),
  CONSTRAINT "operational_lease_owner_fields_consistent"
    CHECK (
      ("owner_token" IS NULL AND "owner_kind" IS NULL AND "owner_id" IS NULL)
      OR
      ("owner_token" IS NOT NULL AND "owner_kind" IS NOT NULL AND "owner_id" IS NOT NULL)
    )
);

CREATE INDEX "operational_lease_expires_at_idx"
  ON "operational_lease"("expires_at");

CREATE INDEX "operational_lease_owner_kind_owner_id_idx"
  ON "operational_lease"("owner_kind", "owner_id");
