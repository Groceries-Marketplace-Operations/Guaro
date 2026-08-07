CREATE TABLE "brand_menu_category" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "brand_id" UUID NOT NULL,
  "category_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "orden" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_menu_category_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_menu_category_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "brand_menu_category_brand_id_category_id_key" ON "brand_menu_category"("brand_id", "category_id");
CREATE INDEX "brand_menu_category_brand_id_active_orden_idx" ON "brand_menu_category"("brand_id", "active", "orden");

INSERT INTO "handler" ("id", "nombre", "created_at", "updated_at")
VALUES ('5db35539-f089-4ce8-baf7-f579bab35fb5', 'commercial_menu_upload', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("nombre") DO NOTHING;

DO $$
DECLARE
  integration_section UUID;
  commercial_handler UUID;
BEGIN
  SELECT "id" INTO integration_section FROM "section"
  WHERE LOWER("nombre") IN ('integration', 'integrations') ORDER BY "created_at" LIMIT 1;
  IF integration_section IS NULL THEN
    RAISE EXCEPTION 'Integration section is required for Commercial Grocery Menu Upload';
  END IF;

  SELECT "id" INTO commercial_handler FROM "handler" WHERE "nombre" = 'commercial_menu_upload';

  INSERT INTO "task_type" (
    "id", "section_id", "nombre", "descripcion", "programable", "activo", "orden", "created_at", "updated_at"
  ) VALUES (
    'c1f6ea1d-e144-49af-9576-8f5a1b13bf2f', integration_section,
    'Commercial Grocery Menu Upload',
    'Upload one validated menu using the categories configured for the brand and apply it to one, selected, or all local brand stores.',
    TRUE, TRUE,
    COALESCE((SELECT MAX("orden") + 1 FROM "task_type" WHERE "section_id" = integration_section), 0),
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("id") DO UPDATE SET
    "section_id" = EXCLUDED."section_id",
    "descripcion" = EXCLUDED."descripcion",
    "programable" = TRUE,
    "activo" = TRUE,
    "updated_at" = CURRENT_TIMESTAMP;

  INSERT INTO "form_field" (
    "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "opciones", "orden", "created_at", "updated_at"
  ) VALUES
    ('864b68d1-bdb1-43b5-b19c-6e8d3d8cc182', 'c1f6ea1d-e144-49af-9576-8f5a1b13bf2f', 'Brand', 'select_brand', TRUE, FALSE, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('54a52929-7344-44fe-a06b-ec2104b67c02', 'c1f6ea1d-e144-49af-9576-8f5a1b13bf2f', 'Store Scope', 'select', TRUE, FALSE, '["One store","Selected stores","All brand stores"]'::jsonb, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('905fe6ed-e90b-4775-8240-103e2336cd94', 'c1f6ea1d-e144-49af-9576-8f5a1b13bf2f', 'Upload Mode', 'select', TRUE, FALSE, '["Merge","Replace"]'::jsonb, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('c56e02a4-e436-49c4-b0df-bf4ff8bcb580', 'c1f6ea1d-e144-49af-9576-8f5a1b13bf2f', 'Excel File', 'file', TRUE, FALSE, NULL, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("task_type_id", "orden") DO NOTHING;

  INSERT INTO "step_definition" (
    "id", "task_type_id", "nombre", "orden", "tipo_ejecucion", "estrategia_asignacion", "peso", "handler_id", "bpo_count", "created_at", "updated_at"
  ) VALUES (
    '953cf27c-bff2-43b2-953b-2b713699317b', 'c1f6ea1d-e144-49af-9576-8f5a1b13bf2f',
    'Validate and Upload Commercial Menu', 1, 'automatic', 'fixed', 1, commercial_handler, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("task_type_id", "orden") DO NOTHING;
END $$;
