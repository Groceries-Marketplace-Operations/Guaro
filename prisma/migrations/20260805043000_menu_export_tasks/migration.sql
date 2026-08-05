INSERT INTO "handler" ("id", "nombre", "created_at", "updated_at")
VALUES
  ('e64d0cca-b42d-49b8-ae3d-c6ad87519ec3', 'export_store_menu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('86dd4cba-b29b-44fc-a03d-71571246829e', 'export_brand_menu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("nombre") DO NOTHING;

DO $$
DECLARE
  operations_section_id UUID;
  store_task_type_id UUID;
  brand_task_type_id UUID;
  store_brand_field_id UUID;
BEGIN
  SELECT "id" INTO operations_section_id
  FROM "section"
  WHERE "nombre" = 'Operations'
  ORDER BY "created_at"
  LIMIT 1;

  IF operations_section_id IS NULL THEN
    RAISE EXCEPTION 'Operations section is required to create menu export tasks';
  END IF;

  SELECT "id" INTO store_task_type_id
  FROM "task_type"
  WHERE "nombre" = 'Download Store Menu Information' AND "deleted_at" IS NULL
  ORDER BY "created_at"
  LIMIT 1;

  IF store_task_type_id IS NULL THEN
    store_task_type_id := 'ff84b344-4276-48cc-804c-8ed2bed76d71';
    INSERT INTO "task_type" (
      "id", "section_id", "nombre", "descripcion", "programable", "activo", "created_at", "updated_at"
    ) VALUES (
      store_task_type_id,
      operations_section_id,
      'Download Store Menu Information',
      'Export the current menu returned by DiDi for one selected store.',
      FALSE,
      TRUE,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;

  SELECT "id" INTO store_brand_field_id
  FROM "form_field"
  WHERE "task_type_id" = store_task_type_id AND "orden" = 1
  LIMIT 1;

  IF store_brand_field_id IS NULL THEN
    store_brand_field_id := 'c2685211-a423-4f96-bd5a-a4d14f3af85f';
    INSERT INTO "form_field" (
      "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "orden", "created_at", "updated_at"
    ) VALUES (
      store_brand_field_id, store_task_type_id, 'Brand', 'select_brand', TRUE, FALSE, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "form_field" WHERE "task_type_id" = store_task_type_id AND "orden" = 2
  ) THEN
    INSERT INTO "form_field" (
      "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "orden", "filtra_por_field", "created_at", "updated_at"
    ) VALUES (
      '36e25ab8-5bcf-41dc-9949-f4336cb42757',
      store_task_type_id,
      'Store',
      'select_store',
      TRUE,
      FALSE,
      2,
      store_brand_field_id,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "step_definition" WHERE "task_type_id" = store_task_type_id AND "orden" = 1
  ) THEN
    INSERT INTO "step_definition" (
      "id", "task_type_id", "nombre", "orden", "tipo_ejecucion", "accion",
      "estrategia_asignacion", "peso", "handler_id", "bpo_count", "created_at", "updated_at"
    ) VALUES (
      '4b216fb0-6e1d-4aef-8488-2768d4d2a2ee',
      store_task_type_id,
      'Download Store Menu',
      1,
      'automatic',
      NULL,
      'round_robin',
      1,
      (SELECT "id" FROM "handler" WHERE "nombre" = 'export_store_menu'),
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;

  SELECT "id" INTO brand_task_type_id
  FROM "task_type"
  WHERE "nombre" = 'Download Local Brand Menu Information' AND "deleted_at" IS NULL
  ORDER BY "created_at"
  LIMIT 1;

  IF brand_task_type_id IS NULL THEN
    brand_task_type_id := '310955a8-f5c9-414c-a190-d63c9af7658a';
    INSERT INTO "task_type" (
      "id", "section_id", "nombre", "descripcion", "programable", "activo", "created_at", "updated_at"
    ) VALUES (
      brand_task_type_id,
      operations_section_id,
      'Download Local Brand Menu Information',
      'Export the consolidated item catalog currently stored locally for one brand.',
      FALSE,
      TRUE,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "form_field" WHERE "task_type_id" = brand_task_type_id AND "orden" = 1
  ) THEN
    INSERT INTO "form_field" (
      "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "orden", "created_at", "updated_at"
    ) VALUES (
      'ec99928b-a4d3-403c-bc65-4ec0430a3974',
      brand_task_type_id,
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
    SELECT 1 FROM "step_definition" WHERE "task_type_id" = brand_task_type_id AND "orden" = 1
  ) THEN
    INSERT INTO "step_definition" (
      "id", "task_type_id", "nombre", "orden", "tipo_ejecucion", "accion",
      "estrategia_asignacion", "peso", "handler_id", "bpo_count", "created_at", "updated_at"
    ) VALUES (
      'cbe31162-fe1a-477d-aee5-d034fdc6651d',
      brand_task_type_id,
      'Download Local Brand Menu',
      1,
      'automatic',
      NULL,
      'round_robin',
      1,
      (SELECT "id" FROM "handler" WHERE "nombre" = 'export_brand_menu'),
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;
END $$;
