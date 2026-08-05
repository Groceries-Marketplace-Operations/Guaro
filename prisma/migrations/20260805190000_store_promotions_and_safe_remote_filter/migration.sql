ALTER TABLE "sftp_application"
ADD COLUMN "brand_id" UUID;

ALTER TABLE "sftp_application"
ADD CONSTRAINT "sftp_application_brand_id_fkey"
FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sftp_application_brand_id_idx" ON "sftp_application"("brand_id");

CREATE TABLE "store_promotion" (
  "id" UUID NOT NULL,
  "sftp_application_id" UUID NOT NULL,
  "shop_external_id" TEXT NOT NULL,
  "activity_id" TEXT NOT NULL,
  "activity_name" TEXT,
  "start_date" TEXT,
  "end_date" TEXT,
  "activity_type" INTEGER,
  "sku" TEXT NOT NULL,
  "discount_amount" TEXT,
  "discount_percentage" TEXT,
  "buy_num" TEXT,
  "get_num" TEXT,
  "bxgy_x" TEXT,
  "bxgy_y" TEXT,
  "action_type" INTEGER,
  "source_file" TEXT NOT NULL,
  "source_modified_at" TIMESTAMPTZ NOT NULL,
  "raw_data" JSONB NOT NULL,
  "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "store_promotion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_promotion_sftp_application_id_fkey"
    FOREIGN KEY ("sftp_application_id") REFERENCES "sftp_application"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "store_promotion_sftp_application_id_shop_external_id_activity_id_sku_key"
ON "store_promotion"("sftp_application_id", "shop_external_id", "activity_id", "sku");
CREATE INDEX "store_promotion_shop_external_id_idx" ON "store_promotion"("shop_external_id");
CREATE INDEX "store_promotion_sftp_application_id_shop_external_id_idx"
ON "store_promotion"("sftp_application_id", "shop_external_id");

CREATE TABLE "promotion_shop_snapshot" (
  "id" UUID NOT NULL,
  "sftp_application_id" UUID NOT NULL,
  "shop_external_id" TEXT NOT NULL,
  "source_file" TEXT NOT NULL,
  "source_modified_at" TIMESTAMPTZ NOT NULL,
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "promotion_shop_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotion_shop_snapshot_sftp_application_id_fkey"
    FOREIGN KEY ("sftp_application_id") REFERENCES "sftp_application"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "promotion_shop_snapshot_sftp_application_id_shop_external_id_key"
ON "promotion_shop_snapshot"("sftp_application_id", "shop_external_id");
CREATE INDEX "promotion_shop_snapshot_sftp_application_id_source_modified_at_idx"
ON "promotion_shop_snapshot"("sftp_application_id", "source_modified_at");

INSERT INTO "handler" ("id", "nombre", "created_at", "updated_at")
VALUES ('44d92cc2-c4d7-43f8-a31b-cae787b46237', 'export_store_promotions', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("nombre") DO NOTHING;

DO $$
DECLARE
  operations_section_id UUID;
  target_task_type_id UUID;
  brand_field_id UUID;
BEGIN
  SELECT "id" INTO operations_section_id
  FROM "section"
  WHERE "nombre" = 'Operations'
  ORDER BY "created_at"
  LIMIT 1;

  IF operations_section_id IS NULL THEN
    RAISE EXCEPTION 'Operations section is required to create the promotion export task';
  END IF;

  SELECT "id" INTO target_task_type_id
  FROM "task_type"
  WHERE "nombre" = 'Download Store Promotions Information' AND "deleted_at" IS NULL
  ORDER BY "created_at"
  LIMIT 1;

  IF target_task_type_id IS NULL THEN
    target_task_type_id := '36f8769e-e80e-4295-a9f6-169186d91ce5';
    INSERT INTO "task_type" (
      "id", "section_id", "nombre", "descripcion", "programable", "activo", "created_at", "updated_at"
    ) VALUES (
      target_task_type_id,
      operations_section_id,
      'Download Store Promotions Information',
      'Export the current promotions stored locally for one selected store.',
      FALSE,
      TRUE,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;

  SELECT "id" INTO brand_field_id
  FROM "form_field"
  WHERE "task_type_id" = target_task_type_id AND "orden" = 1
  LIMIT 1;

  IF brand_field_id IS NULL THEN
    brand_field_id := '7d91fb7d-ae80-49e0-996f-6a9d88085506';
    INSERT INTO "form_field" (
      "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "orden", "created_at", "updated_at"
    ) VALUES (
      brand_field_id, target_task_type_id, 'Brand', 'select_brand', TRUE, FALSE, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "form_field" WHERE "task_type_id" = target_task_type_id AND "orden" = 2) THEN
    INSERT INTO "form_field" (
      "id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "orden", "filtra_por_field", "created_at", "updated_at"
    ) VALUES (
      'd14ab661-3782-4fc9-8f9c-4d689f9286de', target_task_type_id, 'Store', 'select_store', TRUE, FALSE, 2,
      brand_field_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "step_definition" WHERE "task_type_id" = target_task_type_id AND "orden" = 1) THEN
    INSERT INTO "step_definition" (
      "id", "task_type_id", "nombre", "orden", "tipo_ejecucion", "accion",
      "estrategia_asignacion", "peso", "handler_id", "bpo_count", "created_at", "updated_at"
    ) VALUES (
      '2fa1fb83-aede-44cc-8665-50fe90b0d587', target_task_type_id, 'Download Store Promotions', 1,
      'automatic', NULL, 'round_robin', 1,
      (SELECT "id" FROM "handler" WHERE "nombre" = 'export_store_promotions'),
      1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  END IF;
END $$;
