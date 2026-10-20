BEGIN;

CREATE TYPE "DidiOrderWebhookForwardDeliveryStatus" AS ENUM (
  'queued',
  'processing',
  'delivered',
  'failed'
);

CREATE TABLE "didi_order_webhook_forward_target" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "url_encrypted" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "didi_order_webhook_forward_target_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "didi_order_webhook_forward_target_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "didi_order_webhook_forward_delivery" (
  "id" UUID NOT NULL,
  "target_id" UUID NOT NULL,
  "order_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "target_revision" INTEGER NOT NULL,
  "status" "DidiOrderWebhookForwardDeliveryStatus" NOT NULL DEFAULT 'queued',
  "url_encrypted" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "payload_encrypted" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "http_status" INTEGER,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ,
  "delivered_at" TIMESTAMPTZ,
  "failed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "didi_order_webhook_forward_delivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "didi_order_webhook_forward_delivery_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "didi_order_webhook_forward_delivery_target_revision_check" CHECK ("target_revision" > 0)
);

CREATE UNIQUE INDEX "didi_order_webhook_forward_target_application_id_key"
  ON "didi_order_webhook_forward_target"("application_id");

CREATE INDEX "didi_order_webhook_forward_target_enabled_idx"
  ON "didi_order_webhook_forward_target"("enabled");

CREATE UNIQUE INDEX "didi_order_webhook_forward_delivery_target_id_order_id_event_type_key"
  ON "didi_order_webhook_forward_delivery"("target_id", "order_id", "event_type");

CREATE INDEX "didi_order_webhook_forward_delivery_status_created_at_idx"
  ON "didi_order_webhook_forward_delivery"("status", "created_at");

ALTER TABLE "didi_order_webhook_forward_target"
  ADD CONSTRAINT "didi_order_webhook_forward_target_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "application"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "didi_order_webhook_forward_delivery"
  ADD CONSTRAINT "didi_order_webhook_forward_delivery_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "didi_order_webhook_forward_target"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
