UPDATE "auto_turn_off_execution"
SET "error_message" = 'Could not resolve shop_id values from DiDi: POST /v1/shop/shop/list failed: fetch failed'
WHERE "error_message" = 'Could not resolve shop_id values from DiDi: fetch failed';

UPDATE "auto_turn_off_execution"
SET "logs" = jsonb_set(
  COALESCE("logs"::jsonb, '{}'::jsonb),
  '{error}',
  to_jsonb('Could not resolve shop_id values from DiDi: POST /v1/shop/shop/list failed: fetch failed'::text),
  true
)
WHERE "logs"->>'error' = 'Could not resolve shop_id values from DiDi: fetch failed';
