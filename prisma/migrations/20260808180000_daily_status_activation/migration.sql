ALTER TYPE "FileIntegrationKind" ADD VALUE IF NOT EXISTS 'daily_status_activation';

ALTER TABLE "file_integration_rule"
  ADD COLUMN IF NOT EXISTS "daily_time" TEXT,
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Etc/GMT+6',
  ADD COLUMN IF NOT EXISTS "parallelism" INTEGER NOT NULL DEFAULT 1;
