CREATE TABLE "role_section_profile" (
  "rol" "AccountRol" NOT NULL,
  "section_id" UUID NOT NULL,
  "custom_section_access" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_section_profile_pkey" PRIMARY KEY ("rol", "section_id"),
  CONSTRAINT "role_section_profile_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE CASCADE
);

CREATE INDEX "role_section_profile_section_id_idx" ON "role_section_profile"("section_id");

CREATE TABLE "role_section_permission_override" (
  "rol" "AccountRol" NOT NULL,
  "section_id" UUID NOT NULL,
  "permiso" TEXT NOT NULL,
  "permitido" BOOLEAN NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_section_permission_override_pkey" PRIMARY KEY ("rol", "section_id", "permiso"),
  CONSTRAINT "role_section_permission_override_profile_fkey" FOREIGN KEY ("rol", "section_id") REFERENCES "role_section_profile"("rol", "section_id") ON DELETE CASCADE
);

CREATE INDEX "role_section_permission_override_permiso_idx" ON "role_section_permission_override"("permiso");

CREATE TABLE "role_section_scope" (
  "rol" "AccountRol" NOT NULL,
  "profile_section_id" UUID NOT NULL,
  "allowed_section_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_section_scope_pkey" PRIMARY KEY ("rol", "profile_section_id", "allowed_section_id"),
  CONSTRAINT "role_section_scope_profile_fkey" FOREIGN KEY ("rol", "profile_section_id") REFERENCES "role_section_profile"("rol", "section_id") ON DELETE CASCADE,
  CONSTRAINT "role_section_scope_allowed_section_id_fkey" FOREIGN KEY ("allowed_section_id") REFERENCES "section"("id") ON DELETE CASCADE
);

CREATE INDEX "role_section_scope_allowed_section_id_idx" ON "role_section_scope"("allowed_section_id");

CREATE TABLE "account_access_profile" (
  "account_id" UUID NOT NULL,
  "custom_section_access" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_access_profile_pkey" PRIMARY KEY ("account_id"),
  CONSTRAINT "account_access_profile_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE
);

CREATE TABLE "account_permission_override" (
  "account_id" UUID NOT NULL,
  "permiso" TEXT NOT NULL,
  "permitido" BOOLEAN NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_permission_override_pkey" PRIMARY KEY ("account_id", "permiso"),
  CONSTRAINT "account_permission_override_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE
);

CREATE INDEX "account_permission_override_permiso_idx" ON "account_permission_override"("permiso");

CREATE TABLE "account_section_scope" (
  "account_id" UUID NOT NULL,
  "section_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_section_scope_pkey" PRIMARY KEY ("account_id", "section_id"),
  CONSTRAINT "account_section_scope_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE,
  CONSTRAINT "account_section_scope_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE CASCADE
);

CREATE INDEX "account_section_scope_section_id_idx" ON "account_section_scope"("section_id");

CREATE TABLE "access_control_audit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actor_id" UUID NOT NULL,
  "scope_type" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "access_control_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_control_audit_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE RESTRICT
);

CREATE INDEX "access_control_audit_created_at_idx" ON "access_control_audit"("created_at");
CREATE INDEX "access_control_audit_scope_type_scope_key_idx" ON "access_control_audit"("scope_type", "scope_key");
