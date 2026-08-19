BEGIN;

INSERT INTO "webhook" (
  "id", "nombre", "url", "es_alertas", "created_at", "updated_at"
) VALUES (
  'a0700000-0000-4000-8000-000000000001'::uuid,
  'Auto Open Stores — Operations',
  'https://im-dichat.xiaojukeji.com/api/hooks/incoming/e799dc80-b84c-4317-93ed-c32925a27efb',
  FALSE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO UPDATE SET
  "nombre" = EXCLUDED."nombre",
  "url" = EXCLUDED."url",
  "es_alertas" = FALSE,
  "updated_at" = CURRENT_TIMESTAMP;

UPDATE "auto_open_pool"
SET
  "webhook_id" = 'a0700000-0000-4000-8000-000000000001'::uuid,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "managed_key" IN ('ka-MX', 'ka-CO', 'ka-CR');

COMMIT;
