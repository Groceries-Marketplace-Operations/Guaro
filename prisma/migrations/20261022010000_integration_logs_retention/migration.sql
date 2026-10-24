-- Retain file identities independently of the audit history, so cleaning logs
-- never makes old SFTP files eligible for automatic submission again.
ALTER TABLE "sftp_api_processed_file" ALTER COLUMN "run_id" DROP NOT NULL;
ALTER TABLE "sftp_api_processed_file" DROP CONSTRAINT "sftp_api_processed_file_run_id_fkey";
ALTER TABLE "sftp_api_processed_file" ADD CONSTRAINT "sftp_api_processed_file_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "sftp_api_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sftp_api_run_finished_at_id_idx" ON "sftp_api_run"("finished_at", "id");
