BEGIN;

CREATE TYPE "DidiOrderWebhookProfitMode" AS ENUM ('fixed_mxn', 'percentage');

ALTER TABLE "application"
  ADD COLUMN "order_webhook_profit_mode" "DidiOrderWebhookProfitMode",
  ADD COLUMN "order_webhook_profit_value" DECIMAL(18, 6),
  ADD COLUMN "order_webhook_native_to_mxn" DECIMAL(20, 10),
  ADD COLUMN "order_webhook_mxn_per_usd" DECIMAL(20, 10);

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

ALTER TABLE "didi_order_webhook_event"
  ADD COLUMN "order_price_minor" BIGINT,
  ADD COLUMN "real_price_minor" BIGINT,
  ADD COLUMN "real_pay_price_minor" BIGINT,
  ADD COLUMN "order_currency" CHAR(3),
  ADD COLUMN "profit_mode" "DidiOrderWebhookProfitMode",
  ADD COLUMN "profit_value" DECIMAL(18, 6),
  ADD COLUMN "native_to_mxn_rate" DECIMAL(20, 10),
  ADD COLUMN "mxn_per_usd_rate" DECIMAL(20, 10),
  ADD COLUMN "profit_mxn" DECIMAL(20, 4),
  ADD COLUMN "profit_usd" DECIMAL(20, 4);

ALTER TABLE "didi_order_webhook_request"
  ADD COLUMN "profit_recognized" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "didi_order_webhook_event"
  ADD CONSTRAINT "didi_order_webhook_event_prices_check"
    CHECK (
      ("order_price_minor" IS NULL OR "order_price_minor" >= 0)
      AND ("real_price_minor" IS NULL OR "real_price_minor" >= 0)
      AND ("real_pay_price_minor" IS NULL OR "real_pay_price_minor" >= 0)
    ) NOT VALID,
  ADD CONSTRAINT "didi_order_webhook_event_currency_check"
    CHECK ("order_currency" IS NULL OR "order_currency" ~ '^[A-Z]{3}$') NOT VALID,
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

COMMIT;
