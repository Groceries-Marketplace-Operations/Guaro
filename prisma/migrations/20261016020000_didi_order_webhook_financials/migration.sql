BEGIN;

-- All operations are metadata-only, but they still need brief catalog locks.
-- Fail and retry safely instead of waiting behind a long-lived transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The production deployment pre-applies this backward-compatible expansion
-- with psql so the sparse indexes can be built concurrently before Prisma
-- records the migration. Every operation must therefore be replay-safe.
DO $$
BEGIN
  CREATE TYPE "DidiOrderWebhookProfitMode" AS ENUM ('fixed_mxn', 'percentage');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "application"
  ADD COLUMN IF NOT EXISTS "order_webhook_profit_mode" "DidiOrderWebhookProfitMode",
  ADD COLUMN IF NOT EXISTS "order_webhook_profit_value" DECIMAL(18, 6),
  ADD COLUMN IF NOT EXISTS "order_webhook_native_to_mxn" DECIMAL(20, 10),
  ADD COLUMN IF NOT EXISTS "order_webhook_mxn_per_usd" DECIMAL(20, 10);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"application"'::regclass
      AND conname = 'application_order_webhook_profit_config_check'
  ) THEN
    ALTER TABLE "application"
      ADD CONSTRAINT "application_order_webhook_profit_config_check"
      CHECK (
        (
          "order_webhook_profit_mode" IS NULL
          AND "order_webhook_profit_value" IS NULL
          AND "order_webhook_native_to_mxn" IS NULL
          AND "order_webhook_mxn_per_usd" IS NULL
        )
        OR (
          "order_webhook_profit_mode" IS NOT NULL
          AND "order_webhook_profit_value" > 0
          AND ("order_webhook_profit_mode" <> 'percentage' OR "order_webhook_profit_value" <= 100)
          AND ("order_webhook_native_to_mxn" IS NULL OR "order_webhook_native_to_mxn" > 0)
          AND "order_webhook_mxn_per_usd" > 0
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE "didi_order_webhook_event"
  ADD COLUMN IF NOT EXISTS "order_price_minor" BIGINT,
  ADD COLUMN IF NOT EXISTS "real_price_minor" BIGINT,
  ADD COLUMN IF NOT EXISTS "real_pay_price_minor" BIGINT,
  ADD COLUMN IF NOT EXISTS "order_currency" CHAR(3),
  ADD COLUMN IF NOT EXISTS "profit_mode" "DidiOrderWebhookProfitMode",
  ADD COLUMN IF NOT EXISTS "profit_value" DECIMAL(18, 6),
  ADD COLUMN IF NOT EXISTS "native_to_mxn_rate" DECIMAL(20, 10),
  ADD COLUMN IF NOT EXISTS "mxn_per_usd_rate" DECIMAL(20, 10),
  ADD COLUMN IF NOT EXISTS "profit_mxn" DECIMAL(20, 4),
  ADD COLUMN IF NOT EXISTS "profit_usd" DECIMAL(20, 4);

ALTER TABLE "didi_order_webhook_request"
  ADD COLUMN IF NOT EXISTS "profit_recognized" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"didi_order_webhook_event"'::regclass
      AND conname = 'didi_order_webhook_event_prices_check'
  ) THEN
    ALTER TABLE "didi_order_webhook_event"
      ADD CONSTRAINT "didi_order_webhook_event_prices_check"
      CHECK (
        ("order_price_minor" IS NULL OR "order_price_minor" >= 0)
        AND ("real_price_minor" IS NULL OR "real_price_minor" >= 0)
        AND ("real_pay_price_minor" IS NULL OR "real_pay_price_minor" >= 0)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"didi_order_webhook_event"'::regclass
      AND conname = 'didi_order_webhook_event_currency_check'
  ) THEN
    ALTER TABLE "didi_order_webhook_event"
      ADD CONSTRAINT "didi_order_webhook_event_currency_check"
      CHECK ("order_currency" IS NULL OR "order_currency" ~ '^[A-Z]{3}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"didi_order_webhook_event"'::regclass
      AND conname = 'didi_order_webhook_event_profit_snapshot_check'
  ) THEN
    ALTER TABLE "didi_order_webhook_event"
      ADD CONSTRAINT "didi_order_webhook_event_profit_snapshot_check"
      CHECK (
        (
          "profit_mode" IS NULL
          AND "profit_value" IS NULL
          AND "native_to_mxn_rate" IS NULL
          AND "mxn_per_usd_rate" IS NULL
          AND "profit_mxn" IS NULL
          AND "profit_usd" IS NULL
        )
        OR (
          "profit_mode" IS NOT NULL
          AND "profit_value" > 0
          AND ("native_to_mxn_rate" IS NULL OR "native_to_mxn_rate" > 0)
          AND "mxn_per_usd_rate" > 0
          AND "profit_mxn" >= 0
          AND "profit_usd" >= 0
        )
      ) NOT VALID;
  END IF;
END
$$;

COMMIT;
