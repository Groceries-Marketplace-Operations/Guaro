-- File reads now resolve the current root_path from the linked SFTP application.
-- Historical run snapshots retain their original metadata for audit purposes.
ALTER TABLE "sftp_api_rule" DROP COLUMN "folder";
