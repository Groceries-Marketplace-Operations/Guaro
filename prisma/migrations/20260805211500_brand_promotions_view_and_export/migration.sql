INSERT INTO "handler" ("id", "nombre", "created_at", "updated_at")
VALUES ('c83b90f9-7ba9-4af2-8a22-f43d7be297a6', 'export_brand_promotions', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("nombre") DO NOTHING;

DO $$
DECLARE
  operations_section_id UUID;
  target_task_type_id UUID;
BEGIN
  SELECT "id" INTO operations_section_id
  FROM "section"
  WHERE "nombre" = 'Operations'
  ORDER BY "created_at"
  LIMIT 1;

  IF operations_section_id IS NULL THEN
    RAISE EXCEPTION 'Operations section is required to create the brand promotion export task';
  END IF;

  SELECT "id" INTO target_task_type_id
  FROM "task_type"
  WHERE "nombre" = 'Download Brand Promotions Information' AND "deleted_at" IS NULL
  ORDER BY "created_at"
  LIMIT 1;

  IF target_task_type_id IS NULL THEN
    target_task_type_id := '17d38bc4-d529-431e-ad45-6149c74e28ee';
    INSERT INTO "task_type" (
      "id", "section_id", "nombre", "descripcion", "programable", "activo", "created_at", "updated_at"
    ) VALUES (
      target_task_type_id,
      operations_section_id,
      'Download Brand Promotions Information',
      'Export the complete current promotion snapshot stored locally for one brand.',
      FALSE,
      TRUE,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "form_field" WHERE "task_type_id" = target_task_type_id AND "orden" = 1
  ) THEN
    INSERT INTO "form_field" (
      "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "orden", "created_at", "updated_at"
    ) VALUES (
      '7a838525-1bc4-40fb-9c09-c6f92a4dccb5',
      target_task_type_id,
      'Brand',
      'select_brand',
      TRUE,
      FALSE,
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "step_definition" WHERE "task_type_id" = target_task_type_id AND "orden" = 1
  ) THEN
    INSERT INTO "step_definition" (
      "id", "task_type_id", "nombre", "orden", "tipo_ejecucion", "accion",
      "estrategia_asignacion", "peso", "handler_id", "bpo_count", "created_at", "updated_at"
    ) VALUES (
      '4fb8bf6f-11ee-40c7-ae3b-d23b7bd09089',
      target_task_type_id,
      'Download Brand Promotions',
      1,
      'automatic',
      NULL,
      'round_robin',
      1,
      (SELECT "id" FROM "handler" WHERE "nombre" = 'export_brand_promotions'),
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;
END $$;
