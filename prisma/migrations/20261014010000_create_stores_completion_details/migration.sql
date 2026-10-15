-- Mark the Create Stores step with a stable behavior identifier so renaming the
-- task type or step does not remove the mandatory completion requirements.
UPDATE "step_definition" AS sd
SET "accion" = 'capture_created_store_details',
    "updated_at" = CURRENT_TIMESTAMP
FROM "task_type" AS tt
WHERE sd."task_type_id" = tt."id"
  AND lower(tt."nombre") = lower('Create New Stores')
  AND lower(sd."nombre") = lower('Create Stores');
