ALTER TABLE "sftp_api_rule"
  ADD COLUMN "rename_file" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rename_regex" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "rename_replacement" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "convert_encoding" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "source_encoding" TEXT NOT NULL DEFAULT 'windows-1252';
