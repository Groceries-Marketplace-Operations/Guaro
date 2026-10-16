\set ON_ERROR_STOP on

-- This file must be executed by psql with autocommit enabled. PostgreSQL does
-- not allow CREATE/DROP INDEX CONCURRENTLY inside a transaction block.
SET lock_timeout = '30s';
SET statement_timeout = '50min';

-- An interrupted concurrent build can leave an invalid catalog entry. Repair
-- only indexes owned by this release; valid indexes are retained on retries.
WITH expected(index_name, table_name, indexed_columns, predicate_fragment) AS (
  VALUES
    (
      'didi_order_webhook_request_order_id_idx',
      'didi_order_webhook_request',
      ARRAY['order_id', 'application_id']::TEXT[],
      NULL
    ),
    (
      'didi_order_webhook_request_app_shop_id_idx',
      'didi_order_webhook_request',
      ARRAY['app_shop_id', 'application_id']::TEXT[],
      NULL
    ),
    (
      'didi_order_webhook_request_didi_shop_id_idx',
      'didi_order_webhook_request',
      ARRAY['didi_shop_id', 'application_id']::TEXT[],
      NULL
    ),
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
SELECT format(
  'DROP INDEX CONCURRENTLY IF EXISTS %I.%I;',
  index_namespace.nspname,
  index_class.relname
)
FROM expected
JOIN pg_class index_class ON index_class.relname = expected.index_name
JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
WHERE index_namespace.nspname = current_schema()
  AND (
    NOT index_state.indisvalid
    OR NOT index_state.indisready
    OR index_state.indrelid <> to_regclass(format('%I.%I', current_schema(), expected.table_name))
    OR ARRAY(
      SELECT table_attribute.attname
      FROM unnest(index_state.indkey) WITH ORDINALITY AS index_key(attnum, position)
      JOIN pg_attribute table_attribute
        ON table_attribute.attrelid = index_state.indrelid
        AND table_attribute.attnum = index_key.attnum
      WHERE index_key.position <= index_state.indnkeyatts
      ORDER BY index_key.position
    )::TEXT[] <> expected.indexed_columns
    OR (
      expected.predicate_fragment IS NULL
      AND index_state.indpred IS NOT NULL
    )
    OR (
      expected.predicate_fragment IS NOT NULL
      AND (
        index_state.indpred IS NULL
        OR position(
          expected.predicate_fragment
          IN replace(pg_get_expr(index_state.indpred, index_state.indrelid), '"', '')
        ) = 0
      )
    )
  )
\gexec

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_request_order_id_idx"
  ON "didi_order_webhook_request"("order_id", "application_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_request_app_shop_id_idx"
  ON "didi_order_webhook_request"("app_shop_id", "application_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "didi_order_webhook_request_didi_shop_id_idx"
  ON "didi_order_webhook_request"("didi_shop_id", "application_id");

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
