CREATE TABLE "role_permission" (
  "rol" "AccountRol" NOT NULL,
  "permiso" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_permission_pkey" PRIMARY KEY ("rol", "permiso")
);

CREATE INDEX "role_permission_permiso_idx" ON "role_permission"("permiso");

INSERT INTO "role_permission" ("rol", "permiso") VALUES
  ('user', 'dashboard.view'),
  ('user', 'brands.view'),
  ('user', 'tasks.view'),
  ('user', 'tasks.create'),
  ('bpo', 'dashboard.view'),
  ('bpo', 'brands.view'),
  ('bpo', 'tasks.view'),
  ('bpo', 'tasks.create'),
  ('bpo', 'bpo.queue'),
  ('admin', 'dashboard.view'),
  ('admin', 'brands.view'),
  ('admin', 'tasks.view'),
  ('admin', 'tasks.create'),
  ('admin', 'task_types.manage'),
  ('admin', 'sftp_applications.manage'),
  ('admin', 'config.users'),
  ('admin', 'config.invitations'),
  ('admin', 'sections.view'),
  ('director', 'dashboard.view'),
  ('director', 'brands.view'),
  ('director', 'tasks.view')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permission" ("rol", "permiso")
SELECT 'bpo', 'brands.create'
WHERE EXISTS (
  SELECT 1 FROM "account"
  WHERE "deleted_at" IS NULL
    AND 'bpo'::"AccountRol" = ANY("roles")
    AND 'create_brand' = ANY("bpo_permissions")
)
ON CONFLICT DO NOTHING;

INSERT INTO "role_permission" ("rol", "permiso")
SELECT 'admin', mapping.permission
FROM (VALUES
  ('applications', 'applications.manage'),
  ('bpo_team', 'bpo.team'),
  ('handlers', 'config.handlers'),
  ('webhooks', 'config.webhooks')
) AS mapping(module, permission)
WHERE EXISTS (
  SELECT 1 FROM "account"
  WHERE "deleted_at" IS NULL
    AND 'admin'::"AccountRol" = ANY("roles")
    AND mapping.module = ANY("admin_modules")
)
ON CONFLICT DO NOTHING;

INSERT INTO "role_permission" ("rol", "permiso")
SELECT 'admin', permission
FROM (VALUES
  ('integrations.forced_open'),
  ('integrations.auto_stores_fetch'),
  ('integrations.auto_menu_fetch'),
  ('integrations.auto_turn_off'),
  ('integrations.emergencies'),
  ('integrations.promotions_sftp'),
  ('integrations.custom'),
  ('integrations.promotion_api')
) AS integration_permissions(permission)
WHERE EXISTS (
  SELECT 1 FROM "account"
  WHERE "deleted_at" IS NULL
    AND 'admin'::"AccountRol" = ANY("roles")
    AND 'integrations' = ANY("admin_modules")
)
ON CONFLICT DO NOTHING;

INSERT INTO "role_permission" ("rol", "permiso")
SELECT 'bpo', 'applications.manage'
WHERE EXISTS (
  SELECT 1 FROM "account"
  WHERE "deleted_at" IS NULL
    AND 'bpo'::"AccountRol" = ANY("roles")
    AND 'create_application' = ANY("bpo_permissions")
)
ON CONFLICT DO NOTHING;
