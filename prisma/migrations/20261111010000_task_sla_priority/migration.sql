BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TYPE "TaskPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

ALTER TABLE "account"
  ADD COLUMN "delayed_assignments" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "delayed_work_minutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "task_type"
  ADD COLUMN "delivery_minutes" INTEGER,
  ADD COLUMN "work_days" INTEGER[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5],
  ADD COLUMN "work_start_minute" INTEGER NOT NULL DEFAULT 540,
  ADD COLUMN "work_end_minute" INTEGER NOT NULL DEFAULT 1080,
  ADD COLUMN "work_time_zone" TEXT NOT NULL DEFAULT 'America/Mexico_City';

ALTER TABLE "task"
  ADD COLUMN "priority" "TaskPriority" NOT NULL DEFAULT 'normal';

ALTER TABLE "step_instance"
  ADD COLUMN "assigned_at" TIMESTAMPTZ,
  ADD COLUMN "due_at" TIMESTAMPTZ,
  ADD COLUMN "assignment_epoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_reassignment_at" TIMESTAMPTZ,
  ADD COLUMN "sla_paused_at" TIMESTAMPTZ;

CREATE TABLE "task_assignment_delay" (
  "id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "step_instance_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "assignment_epoch" INTEGER NOT NULL,
  "due_at" TIMESTAMPTZ NOT NULL,
  "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delay_minutes" INTEGER NOT NULL,
  "replacement_account_id" UUID,
  CONSTRAINT "task_assignment_delay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_assignment_delay_step_instance_id_assignment_epoch_key"
  ON "task_assignment_delay"("step_instance_id", "assignment_epoch");
CREATE INDEX "task_assignment_delay_account_id_recorded_at_idx"
  ON "task_assignment_delay"("account_id", "recorded_at");
CREATE INDEX "task_assignment_delay_task_id_idx"
  ON "task_assignment_delay"("task_id");
ALTER TABLE "task_assignment_delay"
  ADD CONSTRAINT "task_assignment_delay_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignment_delay"
  ADD CONSTRAINT "task_assignment_delay_step_instance_id_fkey"
  FOREIGN KEY ("step_instance_id") REFERENCES "step_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignment_delay"
  ADD CONSTRAINT "task_assignment_delay_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_assignment_delay"
  ADD CONSTRAINT "task_assignment_delay_replacement_account_id_fkey"
  FOREIGN KEY ("replacement_account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
