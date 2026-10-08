-- CreateTable
CREATE TABLE "sftp_api_rule" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "file_regex" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL DEFAULT '|',
    "has_header" BOOLEAN NOT NULL DEFAULT false,
    "shop_source" TEXT NOT NULL DEFAULT 'filename',
    "shop_regex" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "schedules" JSONB NOT NULL,
    "app_id" TEXT NOT NULL,
    "app_secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "next_run_at" TIMESTAMPTZ,
    "last_read_at" TIMESTAMPTZ,
    "last_upload_at" TIMESTAMPTZ,
    "created_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sftp_api_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sftp_api_run" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actor_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "snapshot" JSONB NOT NULL,
    "error" TEXT,
    "files_read" INTEGER NOT NULL DEFAULT 0,
    "files_skipped" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sftp_api_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sftp_api_upload" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "shop_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "config_hash" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "encrypted_body" TEXT NOT NULL,
    "response" JSONB,
    "http_status" INTEGER,
    "task_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "error" TEXT,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at_mx" TEXT NOT NULL,
    "duration_ms" INTEGER,

    CONSTRAINT "sftp_api_upload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sftp_api_rule_brand_id_key" ON "sftp_api_rule"("brand_id");

-- CreateIndex
CREATE INDEX "sftp_api_rule_active_next_run_at_idx" ON "sftp_api_rule"("active", "next_run_at");

-- CreateIndex
CREATE INDEX "sftp_api_run_rule_id_created_at_idx" ON "sftp_api_run"("rule_id", "created_at");

-- CreateIndex
CREATE INDEX "sftp_api_run_status_idx" ON "sftp_api_run"("status");

-- CreateIndex
CREATE INDEX "sftp_api_upload_run_id_sent_at_idx" ON "sftp_api_upload"("run_id", "sent_at");

-- CreateIndex
CREATE INDEX "sftp_api_upload_file_hash_config_hash_shop_id_status_idx" ON "sftp_api_upload"("file_hash", "config_hash", "shop_id", "status");

-- AddForeignKey
ALTER TABLE "sftp_api_rule" ADD CONSTRAINT "sftp_api_rule_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sftp_api_run" ADD CONSTRAINT "sftp_api_run_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "sftp_api_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sftp_api_upload" ADD CONSTRAINT "sftp_api_upload_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sftp_api_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A brand must not run two menu/stock writers at the same time.
CREATE UNIQUE INDEX "sftp_api_run_one_active_per_rule" ON "sftp_api_run" ("rule_id") WHERE "status" IN ('pending', 'running');

-- New capability is available to administrators; other roles can receive it in the access matrix.
INSERT INTO "role_permission" ("rol", "permiso", "updated_at")
VALUES ('admin', 'integrations.sftp_api', CURRENT_TIMESTAMP), ('admin', 'integrations.sftp_api.configure', CURRENT_TIMESTAMP), ('admin', 'integrations.sftp_api.execute', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
