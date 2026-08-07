INSERT INTO "handler" ("id", "nombre", "created_at", "updated_at") VALUES
  ('23c605e1-f4e3-4f46-b941-e735cf3ece0b', 'update_shop_head_image', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('7a42a886-e474-4423-b419-7cc5a43c50d7', 'replicate_store_menu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('4cf6c68a-b06a-43ef-b510-25550a26c1de', 'scheduled_targeted_menu_upload', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('976f9576-10c0-4387-ae20-d5d0b012218c', 'check_shop_integration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('4dd1abef-0614-4391-a64c-0a81b8e0b67e', 'add_shops_to_integration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("nombre") DO NOTHING;

DO $$
DECLARE
  integration_section UUID;
  menu_handler UUID;
BEGIN
  SELECT "id" INTO integration_section FROM "section"
  WHERE LOWER("nombre") IN ('integration', 'integrations') ORDER BY "created_at" LIMIT 1;
  IF integration_section IS NULL THEN
    integration_section := '79d9dfe4-7583-4432-81f5-23f47c38c1d5';
    INSERT INTO "section" ("id", "nombre", "created_at", "updated_at")
    VALUES (integration_section, 'Integration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING;
  END IF;

  SELECT "id" INTO menu_handler FROM "handler" WHERE "nombre" = 'library_menu_upload';
  IF menu_handler IS NULL THEN
    menu_handler := '8c9de429-f27b-4d2e-87b0-e2cdd980cd72';
    INSERT INTO "handler" ("id", "nombre", "created_at", "updated_at")
    VALUES (menu_handler, 'library_menu_upload', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;

  INSERT INTO "task_type" ("id", "section_id", "nombre", "descripcion", "programable", "activo", "created_at", "updated_at") VALUES
    ('91586c05-b59f-41c7-bc59-f296da8299a1', integration_section, 'Update Store Head Image', 'Upload one secure shop_head_img and apply it to selected stores of the chosen brand.', FALSE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fc93a9fe-e4c1-42ed-948b-acf11647a951', integration_section, 'Upload Grocery Menu to Stores', 'Upload categories and store items from the official Excel template.', FALSE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('e4ae7a1e-d338-461d-8aa0-aa7d352bba86', integration_section, 'Replicate Store Menu', 'Download one reference store menu and upload it to selected target stores of the same brand.', FALSE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('b503df86-081a-4a32-8294-3500546892bf', integration_section, 'Scheduled Targeted Menu Upload', 'Upload categories and items to selected stores beginning at the scheduled date and time.', TRUE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('4ca7b404-008b-4216-a2bf-a324d7fa16dc', integration_section, 'Check Shop Integration', 'Check whether selected shop_id values are returned by the brand application integration.', FALSE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('c95dfd78-c762-402c-a2fa-e4ae62177765', integration_section, 'Add Shops to Integration', 'Validate selected shop_id values with DiDi and add or update them in the local brand integration.', FALSE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("id") DO UPDATE SET "section_id" = EXCLUDED."section_id", "descripcion" = EXCLUDED."descripcion", "activo" = TRUE, "updated_at" = CURRENT_TIMESTAMP;

  INSERT INTO "form_field" ("id", "task_type_id", "etiqueta", "tipo", "requerido", "multiple", "opciones", "orden", "created_at", "updated_at") VALUES
    ('a263763a-adb8-4e9a-95c8-828c8c3c7aa1', '91586c05-b59f-41c7-bc59-f296da8299a1', 'Brand', 'select_brand', TRUE, FALSE, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('d284352d-a62d-4d00-a913-ec41f3782e31', '91586c05-b59f-41c7-bc59-f296da8299a1', 'Target Shop IDs', 'text_box', TRUE, FALSE, NULL, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ad45a779-9c1e-4dc9-b323-d3a9bc8684a4', '91586c05-b59f-41c7-bc59-f296da8299a1', 'Shop Head Image', 'image', TRUE, FALSE, NULL, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

    ('cde35cec-c7b4-4b62-b077-75e6a65d6375', 'fc93a9fe-e4c1-42ed-948b-acf11647a951', 'Brand', 'select_brand', TRUE, FALSE, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('4d8138e7-f70f-41ba-a936-884632781d8a', 'fc93a9fe-e4c1-42ed-948b-acf11647a951', 'Excel File', 'file', TRUE, FALSE, NULL, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

    ('101c93cd-47fd-4dc6-8875-d013287755de', 'e4ae7a1e-d338-461d-8aa0-aa7d352bba86', 'Brand', 'select_brand', TRUE, FALSE, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('816808f2-1bf4-4baa-b4c2-a59313c4d724', 'e4ae7a1e-d338-461d-8aa0-aa7d352bba86', 'Reference Shop ID', 'texto', TRUE, FALSE, NULL, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('4ac63428-8132-4b32-8812-f41152ce9b84', 'e4ae7a1e-d338-461d-8aa0-aa7d352bba86', 'Target Shop IDs', 'text_box', TRUE, FALSE, NULL, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('dddfc10d-6507-4f7d-afac-c827812507c9', 'e4ae7a1e-d338-461d-8aa0-aa7d352bba86', 'Merge Policy', 'select', TRUE, FALSE, '["Overwrite","Merge"]'::jsonb, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

    ('2dcdf7cf-815d-4662-981a-db12ef0bbe09', 'b503df86-081a-4a32-8294-3500546892bf', 'Brand', 'select_brand', TRUE, FALSE, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('b62feb2d-171e-4bfc-bf2f-2f0c1c243f36', 'b503df86-081a-4a32-8294-3500546892bf', 'Excel File', 'file', TRUE, FALSE, NULL, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

    ('70404f87-7ffc-4188-816d-ea5d52b97d68', '4ca7b404-008b-4216-a2bf-a324d7fa16dc', 'Brand', 'select_brand', TRUE, FALSE, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('b48e0da8-a15a-4694-86dd-b7229db842ad', '4ca7b404-008b-4216-a2bf-a324d7fa16dc', 'Target Shop IDs', 'text_box', TRUE, FALSE, NULL, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

    ('4286233c-9400-43af-9d1d-65b26fc00bab', 'c95dfd78-c762-402c-a2fa-e4ae62177765', 'Brand', 'select_brand', TRUE, FALSE, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('5954eb78-7421-4c0a-852c-72f75ef7f93d', 'c95dfd78-c762-402c-a2fa-e4ae62177765', 'Target Shop IDs', 'text_box', TRUE, FALSE, NULL, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("task_type_id", "orden") DO NOTHING;

  INSERT INTO "step_definition" ("id", "task_type_id", "nombre", "orden", "tipo_ejecucion", "estrategia_asignacion", "peso", "handler_id", "bpo_count", "created_at", "updated_at") VALUES
    ('8931cd03-91fd-415a-b8a0-673552d7786d', '91586c05-b59f-41c7-bc59-f296da8299a1', 'Update Store Head Image', 1, 'automatic', 'fixed', 1, (SELECT "id" FROM "handler" WHERE "nombre"='update_shop_head_image'), 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ce3995dd-627a-4074-a1c1-a066b7546a50', 'fc93a9fe-e4c1-42ed-948b-acf11647a951', 'Validate and Upload Grocery Menu', 1, 'automatic', 'fixed', 1, menu_handler, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('697636a6-c59c-4707-9ce7-45e5e80be1fd', 'e4ae7a1e-d338-461d-8aa0-aa7d352bba86', 'Replicate Store Menu', 1, 'automatic', 'fixed', 1, (SELECT "id" FROM "handler" WHERE "nombre"='replicate_store_menu'), 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('5106ecb3-63c3-451a-8200-d5f7e32a0936', 'b503df86-081a-4a32-8294-3500546892bf', 'Scheduled Targeted Menu Upload', 1, 'automatic', 'fixed', 1, (SELECT "id" FROM "handler" WHERE "nombre"='scheduled_targeted_menu_upload'), 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fc2bf159-a40a-47b2-917c-87c1a15b29bc', '4ca7b404-008b-4216-a2bf-a324d7fa16dc', 'Check Shop Integration', 1, 'automatic', 'fixed', 1, (SELECT "id" FROM "handler" WHERE "nombre"='check_shop_integration'), 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('189520a7-3b0f-4c29-b7f4-565496886759', 'c95dfd78-c762-402c-a2fa-e4ae62177765', 'Add Shops to Integration', 1, 'automatic', 'fixed', 1, (SELECT "id" FROM "handler" WHERE "nombre"='add_shops_to_integration'), 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("task_type_id", "orden") DO NOTHING;

  INSERT INTO "task_type_template" ("id", "task_type_id", "name", "url", "tipo", "created_at") VALUES
    ('31390b71-4492-491e-b0ea-8869869fb429', 'fc93a9fe-e4c1-42ed-948b-acf11647a951', 'Grocery menu Excel template', '/guaro/api/tasks/templates/grocery-menu.xlsx', 'excel', CURRENT_TIMESTAMP),
    ('e56d7a75-97f0-4f75-9f82-38d0908cc59e', 'b503df86-081a-4a32-8294-3500546892bf', 'Grocery menu Excel template', '/guaro/api/tasks/templates/grocery-menu.xlsx', 'excel', CURRENT_TIMESTAMP)
  ON CONFLICT ("id") DO NOTHING;
END $$;
