INSERT INTO "handler" ("id", "nombre", "created_at", "updated_at")
VALUES (
  '341244a0-104e-40bb-9e8f-655e569f7c2f',
  'update_shop_logo',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("nombre") DO UPDATE
SET "updated_at" = CURRENT_TIMESTAMP;

DO $$
DECLARE
  integration_section UUID;
  logo_handler UUID;
BEGIN
  SELECT "id" INTO integration_section
  FROM "section"
  WHERE LOWER("nombre") IN ('integration', 'integrations')
  ORDER BY "created_at"
  LIMIT 1;

  IF integration_section IS NULL THEN
    RAISE EXCEPTION 'Integration section is required to create Update Store Logo';
  END IF;

  SELECT "id" INTO logo_handler
  FROM "handler"
  WHERE "nombre" = 'update_shop_logo';

  -- Release gate: the migration can run while the previous backend still serves
  -- traffic, so this TaskType must remain invisible and non-executable. The new
  -- backend atomically consumes the exact description/deleted_at marker during
  -- application bootstrap before activating it.
  INSERT INTO "task_type" (
    "id", "section_id", "nombre", "descripcion", "programable", "activo", "created_at", "updated_at", "deleted_at"
  ) VALUES (
    '1ea33da2-92cd-4ef3-b81e-2fcd764001f1',
    integration_section,
    'Update Store Logo',
    'GUARO_RELEASE_GATE:update_shop_logo:backend-ready:v1',
    FALSE,
    FALSE,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    TIMESTAMP '2999-01-01 00:00:00'
  )
  ON CONFLICT ("id") DO UPDATE SET
    "section_id" = EXCLUDED."section_id",
    "nombre" = EXCLUDED."nombre",
    "descripcion" = EXCLUDED."descripcion",
    "programable" = FALSE,
    "activo" = FALSE,
    "deleted_at" = EXCLUDED."deleted_at",
    "updated_at" = CURRENT_TIMESTAMP;

  INSERT INTO "form_field" (
    "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "opciones", "orden", "created_at", "updated_at"
  ) VALUES
    (
      '4ca80703-75cd-41b4-85c2-3a7319b61591',
      '1ea33da2-92cd-4ef3-b81e-2fcd764001f1',
      'Brand',
      'select_brand',
      TRUE,
      FALSE,
      NULL,
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    ),
    (
      '39dc4c03-93d0-4635-8de0-ce75c1a0d329',
      '1ea33da2-92cd-4ef3-b81e-2fcd764001f1',
      'Target Shop IDs',
      'text_box',
      TRUE,
      FALSE,
      NULL,
      2,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    ),
    (
      '1f2edf90-5feb-45cf-a507-3fd3aaf20264',
      '1ea33da2-92cd-4ef3-b81e-2fcd764001f1',
      'Shop Logo',
      'image',
      TRUE,
      FALSE,
      NULL,
      3,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  ON CONFLICT ("task_type_id", "orden") DO UPDATE SET
    "etiqueta" = EXCLUDED."etiqueta",
    "tipo" = EXCLUDED."tipo",
    "requerido" = EXCLUDED."requerido",
    "multiple" = EXCLUDED."multiple",
    "opciones" = EXCLUDED."opciones",
    "updated_at" = CURRENT_TIMESTAMP;

  INSERT INTO "step_definition" (
    "id", "task_type_id", "nombre", "orden", "tipo_ejecucion", "estrategia_asignacion",
    "peso", "handler_id", "bpo_count", "created_at", "updated_at"
  ) VALUES (
    'ed91997f-d72a-43c4-b4fa-485060da3626',
    '1ea33da2-92cd-4ef3-b81e-2fcd764001f1',
    'Update Store Logo',
    1,
    'automatic',
    'fixed',
    1,
    logo_handler,
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("task_type_id", "orden") DO UPDATE SET
    "nombre" = EXCLUDED."nombre",
    "tipo_ejecucion" = EXCLUDED."tipo_ejecucion",
    "estrategia_asignacion" = EXCLUDED."estrategia_asignacion",
    "handler_id" = EXCLUDED."handler_id",
    "updated_at" = CURRENT_TIMESTAMP;
END $$;
