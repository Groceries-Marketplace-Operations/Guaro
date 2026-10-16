-- Production creates these indexes concurrently before Prisma runs. The
-- non-concurrent fallback keeps fresh development/test databases
-- self-contained and is a no-op when the online deployment step succeeded.
CREATE INDEX IF NOT EXISTS "didi_order_webhook_request_order_id_idx"
  ON "didi_order_webhook_request"("order_id", "application_id");

CREATE INDEX IF NOT EXISTS "didi_order_webhook_request_app_shop_id_idx"
  ON "didi_order_webhook_request"("app_shop_id", "application_id");

CREATE INDEX IF NOT EXISTS "didi_order_webhook_request_didi_shop_id_idx"
  ON "didi_order_webhook_request"("didi_shop_id", "application_id");

DO $$
DECLARE
  missing_indexes TEXT;
BEGIN
  WITH expected(index_name, table_name, indexed_columns) AS (
    VALUES
      (
        'didi_order_webhook_request_order_id_idx',
        'didi_order_webhook_request',
        ARRAY['order_id', 'application_id']::TEXT[]
      ),
      (
        'didi_order_webhook_request_app_shop_id_idx',
        'didi_order_webhook_request',
        ARRAY['app_shop_id', 'application_id']::TEXT[]
      ),
      (
        'didi_order_webhook_request_didi_shop_id_idx',
        'didi_order_webhook_request',
        ARRAY['didi_shop_id', 'application_id']::TEXT[]
      )
  )
  SELECT string_agg(expected.index_name, ', ' ORDER BY expected.index_name)
    INTO missing_indexes
  FROM expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class index_class
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
    JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = expected.index_name
      AND index_state.indrelid = to_regclass(format('%I.%I', current_schema(), expected.table_name))
      AND index_state.indisvalid
      AND index_state.indisready
      AND index_state.indpred IS NULL
      AND ARRAY(
        SELECT table_attribute.attname
        FROM unnest(index_state.indkey) WITH ORDINALITY AS index_key(attnum, position)
        JOIN pg_attribute table_attribute
          ON table_attribute.attrelid = index_state.indrelid
          AND table_attribute.attnum = index_key.attnum
        WHERE index_key.position <= index_state.indnkeyatts
        ORDER BY index_key.position
      )::TEXT[] = expected.indexed_columns
  );

  IF missing_indexes IS NOT NULL THEN
    RAISE EXCEPTION 'Required webhook request indexes are not ready: %', missing_indexes;
  END IF;
END
$$;
