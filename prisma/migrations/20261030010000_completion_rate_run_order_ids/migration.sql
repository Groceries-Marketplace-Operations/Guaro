-- NULL identifies historical runs whose exact evaluated orders were not saved.
ALTER TABLE "completion_rate_run" ADD COLUMN "order_ids" JSONB;
