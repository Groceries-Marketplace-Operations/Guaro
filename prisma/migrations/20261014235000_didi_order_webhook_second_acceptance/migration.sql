-- Track successful confirmations independently from transport attempts. Existing
-- accepted orders have already consumed their first of two allowed acceptances.
ALTER TABLE "didi_order_webhook_event"
  ADD COLUMN "accepted_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "didi_order_webhook_event"
SET "accepted_count" = 1
WHERE "status" = 'accepted';

ALTER TABLE "didi_order_webhook_event"
  ADD CONSTRAINT "didi_order_webhook_event_accepted_count_check"
  CHECK ("accepted_count" >= 0 AND "accepted_count" <= 2);

-- New and modified event rows can only represent the supported discriminator.
-- NOT VALID keeps the rollout compatible if a legacy database contains an
-- unexpected historical row; validate immediately when its existing data is
-- already clean.
ALTER TABLE "didi_order_webhook_event"
  ADD CONSTRAINT "didi_order_webhook_event_order_new_type_check"
  CHECK ("type" = 'orderNew') NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "didi_order_webhook_event"
    WHERE "type" IS DISTINCT FROM 'orderNew'
  ) THEN
    ALTER TABLE "didi_order_webhook_event"
      VALIDATE CONSTRAINT "didi_order_webhook_event_order_new_type_check";
  END IF;
END $$;
