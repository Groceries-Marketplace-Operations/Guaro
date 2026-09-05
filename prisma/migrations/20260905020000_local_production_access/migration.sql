-- Durable, independently attributable local-production access sessions.
CREATE TYPE "LocalProductionAccessAuditAction" AS ENUM ('grant', 'revoke');

CREATE TABLE "local_production_access_session" (
    "id" VARCHAR(64) NOT NULL,
    "target_account_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_production_access_session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "local_production_access_session_id_target_account_id_key"
        UNIQUE ("id", "target_account_id"),
    CONSTRAINT "local_production_access_session_id_check"
        CHECK ("id" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "local_production_access_session_expiry_check"
        CHECK (
            "expires_at" > "created_at"
            AND "expires_at" <= "created_at" + INTERVAL '15 minutes'
        ),
    CONSTRAINT "local_production_access_session_revoked_at_check"
        CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

CREATE TABLE "local_production_access_audit" (
    "id" UUID NOT NULL,
    "target_account_id" UUID NOT NULL,
    "target_email" VARCHAR(320) NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "action" "LocalProductionAccessAuditAction" NOT NULL,
    "ssh_principal" VARCHAR(200) NOT NULL,
    "operator_label" VARCHAR(200) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_production_access_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "local_production_access_audit_session_id_action_key"
        UNIQUE ("session_id", "action"),
    CONSTRAINT "local_production_access_audit_target_email_check"
        CHECK (
            "target_email" = btrim("target_email")
            AND length("target_email") BETWEEN 3 AND 320
        ),
    CONSTRAINT "local_production_access_audit_ssh_principal_check"
        CHECK (
            "ssh_principal" = btrim("ssh_principal")
            AND length("ssh_principal") BETWEEN 3 AND 200
            AND "ssh_principal" !~ '[[:cntrl:]]'
        ),
    CONSTRAINT "local_production_access_audit_operator_label_check"
        CHECK (
            "operator_label" = btrim("operator_label")
            AND length("operator_label") BETWEEN 3 AND 200
        ),
    CONSTRAINT "local_production_access_audit_reason_check"
        CHECK (
            "reason" = btrim("reason")
            AND length("reason") BETWEEN 10 AND 500
        )
);

CREATE INDEX "local_production_access_session_target_account_id_revoked_at_expires_at_idx"
    ON "local_production_access_session"("target_account_id", "revoked_at", "expires_at");
CREATE INDEX "local_production_access_session_expires_at_idx"
    ON "local_production_access_session"("expires_at");
CREATE INDEX "local_production_access_audit_session_id_created_at_idx"
    ON "local_production_access_audit"("session_id", "created_at");
CREATE INDEX "local_production_access_audit_target_account_id_created_at_idx"
    ON "local_production_access_audit"("target_account_id", "created_at");
CREATE INDEX "local_production_access_audit_created_at_idx"
    ON "local_production_access_audit"("created_at");

ALTER TABLE "local_production_access_session"
    ADD CONSTRAINT "local_production_access_session_target_account_id_fkey"
    FOREIGN KEY ("target_account_id") REFERENCES "account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "local_production_access_audit"
    ADD CONSTRAINT "local_production_access_audit_target_account_id_fkey"
    FOREIGN KEY ("target_account_id") REFERENCES "account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "local_production_access_audit"
    ADD CONSTRAINT "local_production_access_audit_session_id_target_account_id_fkey"
    FOREIGN KEY ("session_id", "target_account_id")
    REFERENCES "local_production_access_session"("id", "target_account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
