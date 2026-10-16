CREATE TYPE "DidiOrderWebhookShopResolutionSource" AS ENUM (
  'local',
  'inventory',
  'remote',
  'payload'
);

ALTER TABLE "didi_order_webhook_event"
  ADD COLUMN "shop_resolution_source" "DidiOrderWebhookShopResolutionSource"
  NOT NULL DEFAULT 'local';

-- No resolution CHECK is introduced while the previous backend version can
-- still be serving traffic during the zero-downtime migration window. The new
-- writer always persists an explicit, validated source. PostgreSQL 11+
-- installs this constant default without rewriting existing event rows.
-- Legacy remote rows intentionally retain the default here: the service
-- derives `remote` from remote_shop_validated until a later online backfill.

ALTER TABLE "didi_order_webhook_request"
  ADD COLUMN "shop_resolution_source" "DidiOrderWebhookShopResolutionSource";
