-- Per-application bearer URLs are stored encrypted for authorized retrieval and
-- hashed for public lookup. The clear-text token is never persisted.
ALTER TABLE "application"
  ADD COLUMN "order_webhook_token_encrypted" TEXT,
  ADD COLUMN "order_webhook_token_hash" TEXT,
  ADD COLUMN "order_webhook_created_at" TIMESTAMPTZ,
  ADD COLUMN "order_webhook_rotated_at" TIMESTAMPTZ,
  ADD COLUMN "order_webhook_disabled_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX "application_order_webhook_token_hash_key"
  ON "application"("order_webhook_token_hash");

CREATE TYPE "DidiOrderWebhookStatus" AS ENUM ('processing', 'accepted', 'failed');

-- Only the minimum operational audit is retained. The inbound order payload,
-- customer details, app secret and auth token are deliberately not stored.
CREATE TABLE "didi_order_webhook_event" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "app_shop_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" "DidiOrderWebhookStatus" NOT NULL DEFAULT 'processing',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "source_timestamp" TEXT,
  "remote_http_status" INTEGER,
  "remote_errno" INTEGER,
  "remote_errmsg" TEXT,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accepted_at" TIMESTAMPTZ,
  "failed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "didi_order_webhook_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "didi_order_webhook_event_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "didi_order_webhook_event_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "didi_order_webhook_event_application_id_order_id_type_key"
  ON "didi_order_webhook_event"("application_id", "order_id", "type");
CREATE INDEX "didi_order_webhook_event_status_started_at_idx"
  ON "didi_order_webhook_event"("status", "started_at");
CREATE INDEX "didi_order_webhook_event_shop_id_created_at_idx"
  ON "didi_order_webhook_event"("shop_id", "created_at");
