DO $$
DECLARE
  integration_section_id UUID;
BEGIN
  SELECT "id" INTO integration_section_id
  FROM "section"
  WHERE LOWER("nombre") IN ('integration', 'integrations')
  ORDER BY
    CASE WHEN LOWER("nombre") = 'integration' THEN 0 ELSE 1 END,
    "created_at"
  LIMIT 1;

  IF integration_section_id IS NULL THEN
    integration_section_id := '79d9dfe4-7583-4432-81f5-23f47c38c1d5';
    INSERT INTO "section" ("id", "nombre", "created_at", "updated_at")
    VALUES (integration_section_id, 'Integration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;

  UPDATE "task_type"
  SET
    "section_id" = integration_section_id,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "nombre" IN (
    'Download Brand Promotions Information',
    'Download Local Brand Menu Information',
    'Download Store Menu Information',
    'Download Store Promotions Information'
  )
  AND "deleted_at" IS NULL
  AND "section_id" <> integration_section_id;
END $$;
