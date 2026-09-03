CREATE TYPE "DidiOrderWebhookRequestStage" AS ENUM (
  'received',
  'validation',
  'shop_resolution',
  'idempotency',
  'authentication',
  'confirmation',
  'completed',
  'legacy'
);

CREATE TYPE "DidiOrderWebhookRequestOutcome" AS ENUM (
  'processing',
  'accepted',
  'deduplicated',
  'rejected',
  'failed'
);

-- One row represents one delivery made to a valid per-application URL. The
-- inbound body, request headers, webhook token and DiDi credentials are never
-- persisted. Invalid/unknown URL tokens are intentionally not logged.
CREATE TABLE "didi_order_webhook_request" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "event_id" UUID,
  "app_shop_id" TEXT,
  "order_id" TEXT,
  "type" TEXT,
  "stage" "DidiOrderWebhookRequestStage" NOT NULL DEFAULT 'received',
  "outcome" "DidiOrderWebhookRequestOutcome" NOT NULL DEFAULT 'processing',
  "local_http_status" INTEGER,
  "duration_ms" INTEGER,
  "remote_http_status" INTEGER,
  "remote_errno" INTEGER,
  "remote_errmsg" TEXT,
  "error_message" TEXT,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "didi_order_webhook_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "didi_order_webhook_request_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "didi_order_webhook_request_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "didi_order_webhook_event"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "didi_order_webhook_request_application_id_created_at_idx"
  ON "didi_order_webhook_request"("application_id", "created_at");
CREATE INDEX "didi_order_webhook_request_application_id_outcome_created_at_idx"
  ON "didi_order_webhook_request"("application_id", "outcome", "created_at");
CREATE INDEX "didi_order_webhook_request_event_id_idx"
  ON "didi_order_webhook_request"("event_id");

-- Existing accepted/failed/processing events (including the historical Sally
-- deliveries) become visible immediately. Reusing the event UUID makes this
-- backfill deterministic and safe if production deploy recovery reruns it.
INSERT INTO "didi_order_webhook_request" (
  "id",
  "application_id",
  "event_id",
  "app_shop_id",
  "order_id",
  "type",
  "stage",
  "outcome",
  "local_http_status",
  "duration_ms",
  "remote_http_status",
  "remote_errno",
  "remote_errmsg",
  "error_message",
  "completed_at",
  "created_at",
  "updated_at"
)
SELECT
  event."id",
  event."application_id",
  event."id",
  event."app_shop_id",
  event."order_id",
  event."type",
  'legacy'::"DidiOrderWebhookRequestStage",
  CASE event."status"
    WHEN 'accepted' THEN 'accepted'::"DidiOrderWebhookRequestOutcome"
    WHEN 'failed' THEN 'failed'::"DidiOrderWebhookRequestOutcome"
    ELSE 'processing'::"DidiOrderWebhookRequestOutcome"
  END,
  CASE event."status" WHEN 'accepted' THEN 200 WHEN 'failed' THEN 502 ELSE NULL END,
  CASE
    WHEN COALESCE(event."accepted_at", event."failed_at", event."updated_at") >= event."started_at"
      THEN LEAST(
        2147483647,
        GREATEST(
          0,
          FLOOR(EXTRACT(EPOCH FROM (
            COALESCE(event."accepted_at", event."failed_at", event."updated_at") - event."started_at"
          )) * 1000)
        )
      )::INTEGER
    ELSE NULL
  END,
  event."remote_http_status",
  event."remote_errno",
  event."remote_errmsg",
  event."error_message",
  COALESCE(event."accepted_at", event."failed_at"),
  event."created_at",
  event."updated_at"
FROM "didi_order_webhook_event" event
ON CONFLICT ("id") DO NOTHING;
