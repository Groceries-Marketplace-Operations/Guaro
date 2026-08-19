BEGIN;

ALTER TABLE "store_emergency"
  ADD COLUMN "shutdown_queued_at" TIMESTAMPTZ,
  ADD COLUMN "shutdown_finished_at" TIMESTAMPTZ,
  ADD COLUMN "restore_requested_at" TIMESTAMPTZ,
  ADD COLUMN "restore_queued_at" TIMESTAMPTZ,
  ADD COLUMN "restore_started_at" TIMESTAMPTZ,
  ADD COLUMN "restore_finished_at" TIMESTAMPTZ;

ALTER TABLE "store_emergency_target"
  ADD COLUMN "offline_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "restore_attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "store_emergency_target"
  ADD CONSTRAINT "store_emergency_target_offline_attempts_check" CHECK ("offline_attempts" >= 0),
  ADD CONSTRAINT "store_emergency_target_restore_attempts_check" CHECK ("restore_attempts" >= 0);

CREATE TABLE "store_emergency_event" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "emergency_id" UUID NOT NULL,
  "target_id" UUID,
  "type" VARCHAR(64) NOT NULL,
  "phase" VARCHAR(24) NOT NULL,
  "outcome" VARCHAR(24),
  "source" VARCHAR(24) NOT NULL,
  "actor_id" UUID,
  "attempt" INTEGER,
  "message" TEXT,
  "metadata" JSONB,
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_emergency_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_emergency_event_emergency_id_fkey"
    FOREIGN KEY ("emergency_id") REFERENCES "store_emergency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "store_emergency_event_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "store_emergency_target"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "store_emergency_event_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "store_emergency_event_phase_check"
    CHECK ("phase" IN ('lifecycle', 'shutdown', 'schedule', 'restore', 'system')),
  CONSTRAINT "store_emergency_event_source_check"
    CHECK ("source" IN ('user', 'scheduler', 'worker', 'system', 'migration')),
  CONSTRAINT "store_emergency_event_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('requested', 'queued', 'running', 'succeeded', 'partial', 'failed', 'rescheduled', 'skipped')),
  CONSTRAINT "store_emergency_event_attempt_check"
    CHECK ("attempt" IS NULL OR "attempt" > 0)
);

CREATE INDEX "store_emergency_event_emergency_id_occurred_at_id_idx"
  ON "store_emergency_event"("emergency_id", "occurred_at", "id");
CREATE INDEX "store_emergency_event_target_id_occurred_at_idx"
  ON "store_emergency_event"("target_id", "occurred_at");
CREATE INDEX "store_emergency_event_emergency_id_phase_occurred_at_idx"
  ON "store_emergency_event"("emergency_id", "phase", "occurred_at");

-- Existing aggregate timestamps predate the append-only event log. Backfill
-- only milestones that can be derived without inventing an exact start time.
UPDATE "store_emergency"
SET "shutdown_finished_at" = COALESCE(
  "offline_at",
  CASE WHEN "status" = 'failed' THEN "finished_at" ELSE NULL END
)
WHERE "shutdown_finished_at" IS NULL;

UPDATE "store_emergency"
SET "restore_finished_at" = "finished_at"
WHERE "status" IN ('restored', 'partial_restored', 'restore_failed')
  AND "restore_finished_at" IS NULL;

INSERT INTO "store_emergency_event" (
  "emergency_id", "type", "phase", "outcome", "source", "actor_id",
  "message", "metadata", "occurred_at", "created_at"
)
SELECT
  emergency."id", 'emergency_created', 'lifecycle', 'requested', 'migration', emergency."created_by_id",
  'Historical emergency imported into the event timeline',
  jsonb_build_object('backfilled', true, 'originalSource', 'user'),
  emergency."created_at", CURRENT_TIMESTAMP
FROM "store_emergency" emergency;

INSERT INTO "store_emergency_event" (
  "emergency_id", "type", "phase", "outcome", "source", "message",
  "metadata", "occurred_at", "created_at"
)
SELECT
  emergency."id", 'shutdown_started', 'shutdown', 'running', 'migration',
  'Historical shutdown start reconstructed from the emergency milestone',
  jsonb_build_object('backfilled', true), emergency."started_at", CURRENT_TIMESTAMP
FROM "store_emergency" emergency
WHERE emergency."started_at" IS NOT NULL;

INSERT INTO "store_emergency_event" (
  "emergency_id", "type", "phase", "outcome", "source", "message",
  "metadata", "occurred_at", "created_at"
)
SELECT
  emergency."id",
  CASE
    WHEN target_counts.succeeded = target_counts.total THEN 'shutdown_completed'
    WHEN target_counts.succeeded > 0 THEN 'shutdown_partial'
    ELSE 'shutdown_failed'
  END,
  'shutdown',
  CASE
    WHEN target_counts.succeeded = target_counts.total THEN 'succeeded'
    WHEN target_counts.succeeded > 0 THEN 'partial'
    ELSE 'failed'
  END,
  'migration',
  CONCAT('Historical shutdown summary: ', target_counts.succeeded, '/', target_counts.total, ' store(s) turned off'),
  jsonb_build_object(
    'backfilled', true,
    'total', target_counts.total,
    'succeeded', target_counts.succeeded,
    'failed', target_counts.total - target_counts.succeeded
  ),
  emergency."shutdown_finished_at", CURRENT_TIMESTAMP
FROM "store_emergency" emergency
CROSS JOIN LATERAL (
  SELECT
    COUNT(*)::INTEGER AS total,
    COUNT(*) FILTER (WHERE target."offline_status" = 'done')::INTEGER AS succeeded
  FROM "store_emergency_target" target
  WHERE target."emergency_id" = emergency."id"
) target_counts
WHERE emergency."shutdown_finished_at" IS NOT NULL;

INSERT INTO "store_emergency_event" (
  "emergency_id", "type", "phase", "outcome", "source", "message",
  "metadata", "occurred_at", "created_at"
)
SELECT
  emergency."id",
  CASE
    WHEN emergency."status" = 'restored' THEN 'restore_completed'
    WHEN emergency."status" = 'partial_restored' THEN 'restore_partial'
    ELSE 'restore_failed'
  END,
  'restore',
  CASE
    WHEN emergency."status" = 'restored' THEN 'succeeded'
    WHEN emergency."status" = 'partial_restored' THEN 'partial'
    ELSE 'failed'
  END,
  'migration',
  CONCAT('Historical store reopening ended with status ', emergency."status"),
  jsonb_build_object('backfilled', true),
  emergency."restore_finished_at", CURRENT_TIMESTAMP
FROM "store_emergency" emergency
WHERE emergency."restore_finished_at" IS NOT NULL;

INSERT INTO "store_emergency_event" (
  "emergency_id", "target_id", "type", "phase", "outcome", "source",
  "attempt", "message", "metadata", "occurred_at", "created_at"
)
SELECT
  target."emergency_id", target."id", 'target_shutdown_succeeded', 'shutdown',
  'succeeded', 'migration', NULL, 'Historical store shutdown completed', jsonb_build_object('backfilled', true),
  target."offline_at", CURRENT_TIMESTAMP
FROM "store_emergency_target" target
WHERE target."offline_at" IS NOT NULL;

INSERT INTO "store_emergency_event" (
  "emergency_id", "target_id", "type", "phase", "outcome", "source",
  "attempt", "message", "metadata", "occurred_at", "created_at"
)
SELECT
  target."emergency_id", target."id", 'target_restore_succeeded', 'restore',
  'succeeded', 'migration', NULL, 'Historical store reopening completed', jsonb_build_object('backfilled', true),
  target."restored_at", CURRENT_TIMESTAMP
FROM "store_emergency_target" target
WHERE target."restored_at" IS NOT NULL;

UPDATE "store_emergency_target"
SET "offline_attempts" = 1
WHERE "offline_status" IN ('done', 'failed');

UPDATE "store_emergency_target"
SET "restore_attempts" = 1
WHERE "restore_status" IN ('done', 'failed');

INSERT INTO "store_emergency_event" (
  "emergency_id", "target_id", "type", "phase", "outcome", "source",
  "attempt", "message", "metadata", "occurred_at", "created_at"
)
SELECT
  target."emergency_id", target."id", 'target_shutdown_failed', 'shutdown',
  'failed', 'migration', NULL, 'Historical store shutdown failed; original error remains on the target snapshot',
  jsonb_build_object('backfilled', true, 'inferredTimestamp', true),
  target."updated_at", CURRENT_TIMESTAMP
FROM "store_emergency_target" target
WHERE target."offline_error" IS NOT NULL;

INSERT INTO "store_emergency_event" (
  "emergency_id", "target_id", "type", "phase", "outcome", "source",
  "attempt", "message", "metadata", "occurred_at", "created_at"
)
SELECT
  target."emergency_id", target."id", 'target_restore_failed', 'restore',
  'failed', 'migration', NULL, 'Historical store reopening failed; original error remains on the target snapshot',
  jsonb_build_object('backfilled', true, 'inferredTimestamp', true),
  target."updated_at", CURRENT_TIMESTAMP
FROM "store_emergency_target" target
WHERE target."restore_error" IS NOT NULL;

COMMIT;
