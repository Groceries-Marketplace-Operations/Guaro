BEGIN;

-- Do not change credential sources underneath an active worker.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "sftp_api_run" WHERE "status" = 'running') THEN
    RAISE EXCEPTION 'Wait for running SFTP API executions to finish before migrating';
  END IF;
END $$;

ALTER TABLE "sftp_api_rule"
  ADD COLUMN "application_id" UUID,
  ADD COLUMN "sftp_application_id" UUID;

-- Preserve existing configurations. Prefer the central API credential by App ID;
-- import credentials only when no catalog entry exists. SFTP matches must be unique.
DO $$
DECLARE
  rule RECORD;
  api_id UUID;
  sftp_id UUID;
  matches INTEGER;
BEGIN
  FOR rule IN SELECT r.*, b."country", b."brand_name"
    FROM "sftp_api_rule" r JOIN "brand" b ON b."id" = r."brand_id"
  LOOP
    SELECT "id" INTO api_id FROM "application" WHERE "app_id" = rule."app_id";
    IF api_id IS NULL THEN
      api_id := gen_random_uuid();
      INSERT INTO "application" ("id", "app_id", "app_name", "country", "app_secret", "created_by", "updated_at")
        VALUES (api_id, rule."app_id", 'DiDi Food · ' || rule."brand_name", rule."country", rule."app_secret", rule."created_by_id", CURRENT_TIMESTAMP);
    END IF;

    SELECT COUNT(*), MIN("id"::text)::uuid INTO matches, sftp_id
      FROM "sftp_application"
      WHERE "host" = rule."host" AND "port" = rule."port" AND "username" = rule."username"
        AND "active" = true AND "deleted_at" IS NULL
        AND ("brand_id" = rule."brand_id" OR "brand_id" IS NULL);
    IF matches <> 1 THEN
      sftp_id := gen_random_uuid();
      INSERT INTO "sftp_application" ("id", "name", "host", "port", "username", "password", "root_path", "brand_id", "created_by", "updated_at")
        VALUES (sftp_id, 'SFTP · ' || rule."brand_name", rule."host", rule."port", rule."username", rule."password", rule."folder", rule."brand_id", rule."created_by_id", CURRENT_TIMESTAMP);
    END IF;
    UPDATE "sftp_api_rule" SET "application_id" = api_id, "sftp_application_id" = sftp_id,
      "active" = false, "next_run_at" = NULL, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = rule."id";
  END LOOP;
END $$;

-- Queued legacy requests targeted the previous API. Require an explicit new run.
UPDATE "sftp_api_run" SET "status" = 'failed', "finished_at" = CURRENT_TIMESTAMP,
  "error" = 'Configuración migrada a aplicaciones DiDi Food y SFTP. Revisa las relaciones e inicia una nueva ejecución.'
  WHERE "status" = 'pending';

-- Keep historical configuration metadata, without duplicate encrypted secrets.
UPDATE "sftp_api_run" run SET "snapshot" = (run."snapshot"::jsonb - 'password' - 'appSecret')
  || jsonb_build_object('applicationId', rule."application_id", 'sftpApplicationId', rule."sftp_application_id")
  FROM "sftp_api_rule" rule WHERE rule."id" = run."rule_id";

ALTER TABLE "sftp_api_rule"
  ALTER COLUMN "application_id" SET NOT NULL,
  ALTER COLUMN "sftp_application_id" SET NOT NULL,
  DROP COLUMN "host", DROP COLUMN "port", DROP COLUMN "username", DROP COLUMN "password",
  DROP COLUMN "app_id", DROP COLUMN "app_secret";

CREATE INDEX "sftp_api_rule_application_id_idx" ON "sftp_api_rule"("application_id");
CREATE INDEX "sftp_api_rule_sftp_application_id_idx" ON "sftp_api_rule"("sftp_application_id");
ALTER TABLE "sftp_api_rule" ADD CONSTRAINT "sftp_api_rule_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sftp_api_rule" ADD CONSTRAINT "sftp_api_rule_sftp_application_id_fkey"
  FOREIGN KEY ("sftp_application_id") REFERENCES "sftp_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
