-- Production creates these sparse indexes concurrently before Prisma runs.
-- The non-concurrent fallback only builds them on fresh development/test
-- databases; in production every statement is an inexpensive no-op.
CREATE INDEX IF NOT EXISTS "didi_order_webhook_event_order_price_minor_present_idx"
  ON "didi_order_webhook_event"("order_price_minor")
  WHERE "order_price_minor" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "didi_order_webhook_event_real_price_minor_present_idx"
  ON "didi_order_webhook_event"("real_price_minor")
  WHERE "real_price_minor" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "didi_order_webhook_event_real_pay_price_minor_present_idx"
  ON "didi_order_webhook_event"("real_pay_price_minor")
  WHERE "real_pay_price_minor" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "didi_order_webhook_event_profit_mxn_present_idx"
  ON "didi_order_webhook_event"("profit_mxn")
  WHERE "profit_mxn" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "didi_order_webhook_request_profit_recognized_idx"
  ON "didi_order_webhook_request"("created_at", "id")
  WHERE "profit_recognized" = true;

DO $$
DECLARE
  missing_indexes TEXT;
BEGIN
  WITH expected(index_name, table_name, indexed_columns, predicate_fragment) AS (
    VALUES
      (
        'didi_order_webhook_event_order_price_minor_present_idx',
        'didi_order_webhook_event',
        ARRAY['order_price_minor']::TEXT[],
        'order_price_minor IS NOT NULL'
      ),
      (
        'didi_order_webhook_event_real_price_minor_present_idx',
        'didi_order_webhook_event',
        ARRAY['real_price_minor']::TEXT[],
        'real_price_minor IS NOT NULL'
      ),
      (
        'didi_order_webhook_event_real_pay_price_minor_present_idx',
        'didi_order_webhook_event',
        ARRAY['real_pay_price_minor']::TEXT[],
        'real_pay_price_minor IS NOT NULL'
      ),
      (
        'didi_order_webhook_event_profit_mxn_present_idx',
        'didi_order_webhook_event',
        ARRAY['profit_mxn']::TEXT[],
        'profit_mxn IS NOT NULL'
      ),
      (
        'didi_order_webhook_request_profit_recognized_idx',
        'didi_order_webhook_request',
        ARRAY['created_at', 'id']::TEXT[],
        'profit_recognized'
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
      AND index_state.indpred IS NOT NULL
      AND position(
        expected.predicate_fragment
        IN replace(pg_get_expr(index_state.indpred, index_state.indrelid), '"', '')
      ) > 0
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
    RAISE EXCEPTION 'Required webhook financial indexes are not ready: %', missing_indexes;
  END IF;
END
$$;
