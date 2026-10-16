-- These indexes back exact central-log lookups across millions of request rows.
-- CONCURRENTLY keeps incoming order webhooks writable during deployment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_request_order_id_idx"
  ON "didi_order_webhook_request"("order_id", "application_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_request_app_shop_id_idx"
  ON "didi_order_webhook_request"("app_shop_id", "application_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_request_didi_shop_id_idx"
  ON "didi_order_webhook_request"("didi_shop_id", "application_id");
