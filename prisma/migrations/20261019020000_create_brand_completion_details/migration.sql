-- Give the singular Create New Brand workflow a stable behavior marker. The
-- exact production UUID is preferred, while the exact task/step names keep
-- this migration safe for local databases seeded with different UUIDs.
UPDATE "step_definition" AS sd
SET "accion" = 'capture_created_brand_details',
    "bpo_count" = 1,
    "updated_at" = CURRENT_TIMESTAMP
FROM "task_type" AS tt
WHERE sd."task_type_id" = tt."id"
  AND lower(sd."nombre") = lower('Create Brand')
  AND (sd."accion" IS NULL OR sd."accion" = 'capture_created_brand_details')
  AND (
    tt."id" = '73ea7698-8e91-49ae-b771-0e77ca90cb0a'::uuid
    OR lower(tt."nombre") = lower('Create New Brand')
  );
