-- A complete orderNew payload is a valid first acceptance candidate even
-- before its shop pair has been corroborated by a local or remote inventory.
-- Keep remote_shop_validated truthful while allowing that explicit source to
-- be persisted for idempotency before the DiDi confirmation call.
BEGIN;

-- Fail and remain fully retryable instead of waiting indefinitely behind an
-- unrelated long transaction during deployment. The validation scan gets a
-- separate upper bound and does not block normal reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $$
DECLARE
  canonical_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO canonical_definition
  FROM pg_constraint
  WHERE conrelid = 'didi_order_webhook_event'::regclass
    AND conname = 'didi_order_webhook_event_shop_resolution_check';

  IF canonical_definition IS NOT NULL
     AND canonical_definition LIKE '%shop_resolution_source%'
     AND canonical_definition LIKE '%payload%' THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'didi_order_webhook_event'::regclass
      AND conname = 'didi_order_webhook_event_shop_resolution_payload_check'
  ) THEN
    ALTER TABLE "didi_order_webhook_event"
      ADD CONSTRAINT "didi_order_webhook_event_shop_resolution_payload_check"
      CHECK (
        "shop_id" IS NOT NULL
        OR (
          "didi_shop_id" IS NOT NULL
          AND (
            "remote_shop_validated" = true
            OR "shop_resolution_source" = 'payload'::"DidiOrderWebhookShopResolutionSource"
          )
        )
      ) NOT VALID;
  END IF;
END $$;

COMMIT;

-- NOT VALID keeps the initial lock metadata-only; validation permits normal
-- reads and writes while PostgreSQL verifies existing rows.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'didi_order_webhook_event'::regclass
      AND conname = 'didi_order_webhook_event_shop_resolution_payload_check'
      AND NOT convalidated
  ) THEN
    ALTER TABLE "didi_order_webhook_event"
      VALIDATE CONSTRAINT "didi_order_webhook_event_shop_resolution_payload_check";
  END IF;
END $$;

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'didi_order_webhook_event'::regclass
      AND conname = 'didi_order_webhook_event_shop_resolution_payload_check'
  ) THEN
    ALTER TABLE "didi_order_webhook_event"
      DROP CONSTRAINT IF EXISTS "didi_order_webhook_event_shop_resolution_check";
    ALTER TABLE "didi_order_webhook_event"
      RENAME CONSTRAINT "didi_order_webhook_event_shop_resolution_payload_check"
      TO "didi_order_webhook_event_shop_resolution_check";
  END IF;
END $$;

COMMIT;
