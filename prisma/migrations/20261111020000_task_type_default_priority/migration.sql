BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "task_type"
  ADD COLUMN "default_priority" "TaskPriority" NOT NULL DEFAULT 'normal';

COMMIT;
