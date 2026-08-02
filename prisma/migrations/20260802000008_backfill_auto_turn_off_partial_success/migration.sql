UPDATE "auto_turn_off_shop_execution"
SET "status" = 'partial_success',
    "current_step" = 'partial_success'
WHERE "status" = 'failed'
  AND "items_succeeded" > 0;

UPDATE "auto_turn_off_execution"
SET "status" = 'partial_success',
    "current_step" = 'partial_success'
WHERE "status" = 'failed'
  AND "items_turned_off" > 0;
