UPDATE "sftp_application"
SET
  "host" = '117.51.1.122',
  "updated_at" = CURRENT_TIMESTAMP
WHERE LOWER("name") = 'soriana'
  AND "deleted_at" IS NULL;

UPDATE "file_integration_rule"
SET
  "file_pattern" = 'preciosdidi*',
  "source_scope" = 'all',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "kind" = 'price_filter'
  AND "deleted_at" IS NULL
  AND "sftp_application_id" IN (
    SELECT "id"
    FROM "sftp_application"
    WHERE LOWER("name") = 'soriana'
      AND "deleted_at" IS NULL
  );
