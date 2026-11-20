INSERT INTO "role_permission" ("rol", "permiso", "updated_at")
VALUES
  ('admin', 'integrations.sftp_processing', CURRENT_TIMESTAMP),
  ('admin', 'integrations.sftp_processing.configure', CURRENT_TIMESTAMP),
  ('admin', 'integrations.sftp_processing.execute', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
