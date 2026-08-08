-- Preserve existing access while splitting broad module permissions into actions.
INSERT INTO "role_permission" ("rol", "permiso")
SELECT current_permission."rol", mapping.child
FROM "role_permission" AS current_permission
JOIN (VALUES
  ('brands.view', 'brands.update'),
  ('brands.view', 'brands.delete'),
  ('tasks.view', 'tasks.execute'),
  ('tasks.view', 'tasks.assign'),
  ('applications.manage', 'applications.create'),
  ('applications.manage', 'applications.update'),
  ('applications.manage', 'applications.delete'),
  ('sftp_applications.manage', 'sftp_applications.update'),
  ('sftp_applications.manage', 'sftp_applications.test'),
  ('integrations.forced_open', 'integrations.forced_open.configure'),
  ('integrations.forced_open', 'integrations.forced_open.execute'),
  ('integrations.auto_stores_fetch', 'integrations.auto_stores_fetch.configure'),
  ('integrations.auto_stores_fetch', 'integrations.auto_stores_fetch.execute'),
  ('integrations.auto_menu_fetch', 'integrations.auto_menu_fetch.configure'),
  ('integrations.auto_menu_fetch', 'integrations.auto_menu_fetch.execute'),
  ('integrations.auto_turn_off', 'integrations.auto_turn_off.configure'),
  ('integrations.auto_turn_off', 'integrations.auto_turn_off.execute'),
  ('integrations.emergencies', 'integrations.emergencies.execute'),
  ('integrations.promotions_sftp', 'integrations.promotions_sftp.configure'),
  ('integrations.promotions_sftp', 'integrations.promotions_sftp.execute'),
  ('integrations.custom', 'integrations.custom.configure'),
  ('integrations.custom', 'integrations.custom.execute'),
  ('integrations.promotion_api', 'integrations.promotion_api.execute'),
  ('config.webhooks', 'config.webhooks.update'),
  ('config.invitations', 'config.invitations.update'),
  ('config.users', 'config.users.update'),
  ('config.users', 'config.users.delete')
) AS mapping(parent, child) ON mapping.parent = current_permission."permiso"
WHERE
  (mapping.child NOT IN ('brands.update', 'brands.delete', 'tasks.assign', 'applications.update', 'applications.delete') OR current_permission."rol" = 'admin')
  AND (mapping.child <> 'tasks.execute' OR current_permission."rol" IN ('bpo', 'admin'))
  AND (mapping.child <> 'applications.create' OR current_permission."rol" IN ('bpo', 'admin'))
ON CONFLICT DO NOTHING;
