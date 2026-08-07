CREATE TYPE "ShopPickingModel" AS ENUM ('store_picking', 'qr_code_2in1', 'prepaid_card_2in1');

ALTER TABLE "section" ADD COLUMN "orden" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "task_type" ADD COLUMN "orden" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shop" ADD COLUMN "picking_model" "ShopPickingModel";
ALTER TABLE "shop" ADD COLUMN "driver_cash_blocked" BOOLEAN NOT NULL DEFAULT TRUE;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY LOWER("nombre"), "created_at", "id") - 1 AS position
  FROM "section"
)
UPDATE "section" AS target SET "orden" = ranked.position
FROM ranked WHERE target."id" = ranked."id";

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "section_id" ORDER BY LOWER("nombre"), "created_at", "id") - 1 AS position
  FROM "task_type"
)
UPDATE "task_type" AS target SET "orden" = ranked.position
FROM ranked WHERE target."id" = ranked."id";

CREATE TABLE "role_section_access" (
  "rol" "AccountRol" NOT NULL,
  "section_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_section_access_pkey" PRIMARY KEY ("rol", "section_id"),
  CONSTRAINT "role_section_access_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "role_section_access_section_id_idx" ON "role_section_access"("section_id");

INSERT INTO "role_section_access" ("rol", "section_id")
SELECT role_name, section."id"
FROM "section"
CROSS JOIN (VALUES
  ('user'::"AccountRol"),
  ('bpo'::"AccountRol"),
  ('admin'::"AccountRol"),
  ('director'::"AccountRol")
) AS roles(role_name)
ON CONFLICT DO NOTHING;

UPDATE "form_field"
SET "etiqueta" = 'Shop Integration Excel', "tipo" = 'file', "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = '5954eb78-7421-4c0a-852c-72f75ef7f93d';

UPDATE "task_type"
SET "descripcion" = 'Upload shop_id, app_shop_id, weekly business hours and picking model. Driver cash blocking defaults to enabled.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'c95dfd78-c762-402c-a2fa-e4ae62177765';

INSERT INTO "task_type_template" ("id", "task_type_id", "name", "url", "tipo", "created_at")
VALUES (
  'f66e55c6-cc48-4e74-947c-c2e87bd35463',
  'c95dfd78-c762-402c-a2fa-e4ae62177765',
  'Shop integration Excel template',
  '/guaro/api/tasks/templates/add-shops.xlsx',
  'excel',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
