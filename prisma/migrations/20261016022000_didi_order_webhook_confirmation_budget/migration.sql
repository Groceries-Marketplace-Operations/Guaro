BEGIN;

ALTER TABLE "didi_order_webhook_event"
  ADD COLUMN "confirmation_calls" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "didi_order_webhook_event"
  ADD CONSTRAINT "didi_order_webhook_event_confirmation_calls_check"
  CHECK ("confirmation_calls" >= 0 AND "confirmation_calls" <= 2) NOT VALID;

-- Legacy rows intentionally remain at zero. Runtime reservations use
-- GREATEST(confirmation_calls, accepted_count), so accepted_count remains the
-- durable lower bound without a multi-million-row backfill in this release.

COMMIT;
