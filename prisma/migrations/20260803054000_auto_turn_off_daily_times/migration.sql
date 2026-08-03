ALTER TABLE "auto_turn_off_rule"
  ADD COLUMN "schedule_mode" TEXT NOT NULL DEFAULT 'interval',
  ADD COLUMN "execution_times" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
