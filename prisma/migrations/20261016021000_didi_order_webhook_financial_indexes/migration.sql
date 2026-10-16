-- New financial columns are null on every legacy row. Partial concurrent
-- indexes avoid indexing millions of nulls or blocking webhook writes while
-- making the new amount/profit filters scale as financial data accumulates.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_event_order_price_minor_present_idx"
  ON "didi_order_webhook_event"("order_price_minor")
  WHERE "order_price_minor" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_event_real_price_minor_present_idx"
  ON "didi_order_webhook_event"("real_price_minor")
  WHERE "real_price_minor" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_event_real_pay_price_minor_present_idx"
  ON "didi_order_webhook_event"("real_pay_price_minor")
  WHERE "real_pay_price_minor" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_event_profit_mxn_present_idx"
  ON "didi_order_webhook_event"("profit_mxn")
  WHERE "profit_mxn" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_request_profit_recognized_idx"
  ON "didi_order_webhook_request"("created_at", "id")
  WHERE "profit_recognized" = true;
