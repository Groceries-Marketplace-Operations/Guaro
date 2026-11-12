-- Build indexes on existing high-traffic tables without blocking writes.
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '20min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "step_instance_due_at_next_reassignment_at_idx"
  ON "step_instance"("due_at", "next_reassignment_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "task_priority_estado_created_at_idx"
  ON "task"("priority", "estado", "created_at");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname IN (
      'step_instance_due_at_next_reassignment_at_idx',
      'task_priority_estado_created_at_idx'
    ) AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'A task SLA index is invalid; stop deployment and repair it before retrying';
  END IF;
END;
$$;
