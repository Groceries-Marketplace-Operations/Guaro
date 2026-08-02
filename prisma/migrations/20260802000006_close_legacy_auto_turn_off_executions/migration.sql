UPDATE "auto_turn_off_execution"
SET "status" = 'failed',
    "current_step" = 'failed',
    "error_message" = 'Execution was interrupted by the shop-worker architecture migration; run the rule again.',
    "finished_at" = CURRENT_TIMESTAMP,
    "progress_percent" = 100
WHERE "status" IN ('pending', 'running');
