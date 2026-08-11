INSERT INTO "role_permission" ("rol", "permiso")
VALUES ('admin', 'task_types.manage')
ON CONFLICT DO NOTHING;

DELETE FROM "role_section_permission_override"
WHERE "rol" = 'admin'
  AND "permiso" = 'task_types.manage'
  AND "permitido" = FALSE;

DELETE FROM "account_permission_override" AS override
USING "account" AS account
WHERE override."account_id" = account."id"
  AND 'admin'::"AccountRol" = ANY(account."roles")
  AND override."permiso" = 'task_types.manage'
  AND override."permitido" = FALSE;
