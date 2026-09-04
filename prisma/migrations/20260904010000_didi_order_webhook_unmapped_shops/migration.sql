BEGIN;

ALTER TABLE "didi_order_webhook_event"
  ADD COLUMN "didi_shop_id" TEXT,
  ADD COLUMN "remote_shop_validated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "didi_order_webhook_event" AS event
SET "didi_shop_id" = shop."shop_id"
FROM "shop" AS shop
WHERE event."shop_id" = shop."id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "didi_order_webhook_event"
    WHERE "didi_shop_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot backfill didi_order_webhook_event.didi_shop_id';
  END IF;
END $$;

ALTER TABLE "didi_order_webhook_event"
  ALTER COLUMN "shop_id" DROP NOT NULL;

ALTER TABLE "didi_order_webhook_event"
  ADD CONSTRAINT "didi_order_webhook_event_shop_resolution_check"
  CHECK (
    "shop_id" IS NOT NULL
    OR ("didi_shop_id" IS NOT NULL AND "remote_shop_validated" = true)
  );

ALTER TABLE "didi_order_webhook_request"
  ADD COLUMN "didi_shop_id" TEXT,
  ADD COLUMN "remote_shop_validated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "didi_order_webhook_request" AS request
SET "didi_shop_id" = event."didi_shop_id",
    "remote_shop_validated" = event."remote_shop_validated"
FROM "didi_order_webhook_event" AS event
WHERE request."event_id" = event."id";

COMMIT;
