-- Store Onboarding operational foundation.
-- DDL only: no control, rollout, request, enrollment, outbox, delivery or seed
-- rows are inserted. Missing control is fail-closed (master OFF).

-- CreateEnum
CREATE TYPE "StoreOnboardingSource" AS ENUM ('create', 'duplicate', 'manual');

-- CreateEnum
CREATE TYPE "StoreOnboardingStatus" AS ENUM ('active', 'partial_success', 'done', 'blocked', 'cancelled');

-- CreateEnum
CREATE TYPE "StoreOnboardingStage" AS ENUM ('created', 'awaiting_shop_ids', 'awaiting_configuration_brief', 'integration_queued', 'configuring', 'configuration_validated', 'audit_preparing', 'awaiting_audit', 'audit_needs_information', 'audit_rejected', 'audit_approved', 'rtbo', 'integration_complete', 'awaiting_go_live', 'going_online', 'online', 'online_failed', 'no_coverage', 'creation_failed', 'blocked', 'cancelled');

-- CreateEnum
CREATE TYPE "StoreOnboardingAuditStatus" AS ENUM ('pending', 'needs_information', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "StoreOnboardingEtaConfidence" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "StoreOnboardingGoLiveSource" AS ENUM ('manual', 'auto_open', 'forced_open');

-- CreateEnum
CREATE TYPE "StoreOnboardingGoLiveStatus" AS ENUM ('running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "StoreOnboardingEnrollmentDecision" AS ENUM ('enrolled', 'excluded');

-- CreateEnum
CREATE TYPE "BrandProvisioningStatus" AS ENUM ('pending', 'ready', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "TaskDependencyStatus" AS ENUM ('waiting', 'satisfied', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "StoreOnboardingNotificationFrequency" AS ENUM ('immediate', 'digest', 'scheduled');

-- CreateEnum
CREATE TYPE "StoreOnboardingOutboxStatus" AS ENUM ('pending', 'processing', 'dispatched', 'suppressed', 'failed');

-- CreateEnum
CREATE TYPE "StoreOnboardingDeliveryStatus" AS ENUM ('pending', 'processing', 'retry_wait', 'delivered', 'failed', 'suppressed');

-- CreateTable
CREATE TABLE "store_onboarding_control" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "global_enabled" BOOLEAN NOT NULL DEFAULT false,
    "notifications_enabled" BOOLEAN NOT NULL DEFAULT false,
    "global_enabled_at" TIMESTAMPTZ,
    "notifications_enabled_at" TIMESTAMPTZ,
    "activation_confirmed_at" TIMESTAMPTZ,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_onboarding_control_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_control_revision" (
    "id" UUID NOT NULL,
    "control_id" TEXT NOT NULL DEFAULT 'default',
    "before_global_enabled" BOOLEAN NOT NULL,
    "after_global_enabled" BOOLEAN NOT NULL,
    "before_notifications_enabled" BOOLEAN NOT NULL,
    "after_notifications_enabled" BOOLEAN NOT NULL,
    "activation_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "actor_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_onboarding_control_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_rollout_revision" (
    "id" UUID NOT NULL,
    "country" "Country" NOT NULL,
    "ka_type" "KaType" NOT NULL,
    "revision" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "effective_at" TIMESTAMPTZ NOT NULL,
    "workflow_version" TEXT NOT NULL,
    "new_requests_only" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "notification_profile_id" UUID,
    "brand_task_type_id" UUID,
    "activated_at" TIMESTAMPTZ,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_onboarding_rollout_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_rollout_source" (
    "rollout_revision_id" UUID NOT NULL,
    "source" "StoreOnboardingSource" NOT NULL,
    "task_type_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_onboarding_rollout_source_pkey" PRIMARY KEY ("rollout_revision_id","source")
);

-- CreateTable
CREATE TABLE "store_onboarding_notification_profile" (
    "id" UUID NOT NULL,
    "logical_key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "country" "Country",
    "ka_type" "KaType",
    "sources" "StoreOnboardingSource"[] NOT NULL,
    "webhook_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" "StoreOnboardingNotificationFrequency" NOT NULL,
    "interval_minutes" INTEGER,
    "scheduled_time" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "critical_events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "activated_at" TIMESTAMPTZ,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_onboarding_notification_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_notification_template" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_onboarding_notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_task_enrollment" (
    "task_id" UUID NOT NULL,
    "decision" "StoreOnboardingEnrollmentDecision" NOT NULL,
    "source" "StoreOnboardingSource" NOT NULL,
    "reason" VARCHAR(80) NOT NULL,
    "rollout_revision_id" UUID,
    "country_snapshot" "Country",
    "ka_type_snapshot" "KaType",
    "workflow_version" TEXT,
    "task_created_at" TIMESTAMPTZ NOT NULL,
    "evaluated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eligibility_snapshot" JSONB NOT NULL,

    CONSTRAINT "store_onboarding_task_enrollment_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "brand_provisioning" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "source_task_id" UUID,
    "status" "BrandProvisioningStatus" NOT NULL DEFAULT 'pending',
    "auto_completed" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ready_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "brand_provisioning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependency" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "prerequisite_task_id" UUID,
    "brand_provisioning_id" UUID NOT NULL,
    "kind" VARCHAR(80) NOT NULL DEFAULT 'brand_ready',
    "status" "TaskDependencyStatus" NOT NULL,
    "auto_completed" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ NOT NULL,
    "satisfied_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "task_dependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_request" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "source" "StoreOnboardingSource" NOT NULL,
    "status" "StoreOnboardingStatus" NOT NULL DEFAULT 'active',
    "current_stage" "StoreOnboardingStage" NOT NULL DEFAULT 'created',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "total_units" INTEGER NOT NULL DEFAULT 0,
    "completed_units" INTEGER NOT NULL DEFAULT 0,
    "failed_units" INTEGER NOT NULL DEFAULT 0,
    "rollout_revision_id" UUID NOT NULL,
    "workflow_version" TEXT NOT NULL,
    "country_snapshot" "Country" NOT NULL,
    "ka_type_snapshot" "KaType" NOT NULL,
    "enrollment_snapshot" JSONB NOT NULL,
    "brand_provisioning_id" UUID NOT NULL,
    "configuration_brief" TEXT,
    "configuration_brief_fields" JSONB,
    "shop_ids_validated_at" TIMESTAMPTZ,
    "shop_ids_validation_source" VARCHAR(80),
    "configuration_brief_assignee_id" UUID,
    "configuration_prepared_by_id" UUID,
    "configuration_prepared_at" TIMESTAMPTZ,
    "estimated_completion_at" TIMESTAMPTZ,
    "eta_confidence" "StoreOnboardingEtaConfidence",
    "eta_calculated_at" TIMESTAMPTZ,
    "created_by_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_onboarding_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_batch" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "source_step_instance_id" UUID,
    "brand_provisioning_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_onboarding_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_unit" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "shop_id" UUID,
    "external_shop_id" TEXT NOT NULL,
    "app_shop_id" TEXT,
    "stage" "StoreOnboardingStage" NOT NULL DEFAULT 'created',
    "blocked_from_stage" "StoreOnboardingStage",
    "configuration_assignee_id" UUID,
    "commercial_assignee_id" UUID,
    "go_live_assignee_id" UUID,
    "checklist" JSONB,
    "configuration_input" JSONB,
    "last_note" TEXT,
    "last_error" TEXT,
    "audit_status" "StoreOnboardingAuditStatus",
    "audit_note" TEXT,
    "audit_evidence" JSONB,
    "audited_by_id" UUID,
    "audited_at" TIMESTAMPTZ,
    "configuration_completed_at" TIMESTAMPTZ,
    "rtbo_at" TIMESTAMPTZ,
    "online_at" TIMESTAMPTZ,
    "online_source" "StoreOnboardingGoLiveSource",
    "online_external_ref" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_onboarding_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_transition" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "from_stage" "StoreOnboardingStage" NOT NULL,
    "to_stage" "StoreOnboardingStage" NOT NULL,
    "actor_id" UUID,
    "note" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_onboarding_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_forecast_snapshot" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "estimated_completion_at" TIMESTAMPTZ NOT NULL,
    "confidence" "StoreOnboardingEtaConfidence" NOT NULL,
    "stage_estimates" JSONB NOT NULL,
    "queue_units" INTEGER NOT NULL DEFAULT 0,
    "explanation" TEXT NOT NULL,
    "calculated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_onboarding_forecast_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_go_live_attempt" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "source" "StoreOnboardingGoLiveSource" NOT NULL,
    "status" "StoreOnboardingGoLiveStatus" NOT NULL DEFAULT 'running',
    "actor_id" UUID,
    "endpoint" TEXT NOT NULL DEFAULT 'manual-confirmation',
    "external_ref" TEXT,
    "response" JSONB,
    "error" TEXT,
    "remote_biz_status" INTEGER,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "store_onboarding_go_live_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_outbox_event" (
    "id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(80) NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "request_id" UUID,
    "task_id" UUID,
    "unit_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "StoreOnboardingOutboxStatus" NOT NULL DEFAULT 'pending',
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_onboarding_outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_onboarding_notification_delivery" (
    "id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "profile_revision_id" UUID NOT NULL,
    "status" "StoreOnboardingDeliveryStatus" NOT NULL DEFAULT 'pending',
    "rendered_body" TEXT,
    "group_key" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMPTZ,
    "last_attempt_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "response_status" INTEGER,
    "response_body" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_onboarding_notification_delivery_pkey" PRIMARY KEY ("id")
);

-- Configuration and lifecycle invariants are also enforced by PostgreSQL so
-- a future caller cannot accidentally create a retroactive rollout or an
-- invalid notification schedule outside the API.
ALTER TABLE "store_onboarding_rollout_revision"
  ADD CONSTRAINT "store_onboarding_rollout_revision_new_only_check"
  CHECK ("new_requests_only" = true);
ALTER TABLE "store_onboarding_notification_profile"
  ADD CONSTRAINT "store_onboarding_notification_profile_sources_check"
  CHECK (cardinality("sources") BETWEEN 1 AND 3);
ALTER TABLE "store_onboarding_notification_profile"
  ADD CONSTRAINT "store_onboarding_notification_profile_frequency_check"
  CHECK (
    ("frequency" = 'immediate' AND "interval_minutes" IS NULL AND "scheduled_time" IS NULL)
    OR ("frequency" = 'digest' AND "interval_minutes" BETWEEN 1 AND 10080 AND "scheduled_time" IS NULL)
    OR ("frequency" = 'scheduled' AND "interval_minutes" IS NULL AND "scheduled_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  );
ALTER TABLE "store_onboarding_notification_template"
  ADD CONSTRAINT "store_onboarding_notification_template_content_check"
  CHECK (length(btrim("content")) > 0);
ALTER TABLE "store_onboarding_unit"
  ADD CONSTRAINT "store_onboarding_unit_external_shop_id_check"
  CHECK (length(btrim("external_shop_id")) > 0);

-- CreateIndex
CREATE INDEX "store_onboarding_control_revision_control_id_created_at_idx" ON "store_onboarding_control_revision"("control_id", "created_at");

-- CreateIndex
CREATE INDEX "store_onboarding_control_revision_actor_id_created_at_idx" ON "store_onboarding_control_revision"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "so_rollout_scope_created_idx" ON "store_onboarding_rollout_revision"("country", "ka_type", "created_at");

-- CreateIndex
CREATE INDEX "store_onboarding_rollout_revision_enabled_effective_at_idx" ON "store_onboarding_rollout_revision"("enabled", "effective_at");

-- CreateIndex
CREATE INDEX "store_onboarding_rollout_revision_notification_profile_id_idx" ON "store_onboarding_rollout_revision"("notification_profile_id");

-- CreateIndex
CREATE INDEX "store_onboarding_rollout_revision_brand_task_type_id_idx" ON "store_onboarding_rollout_revision"("brand_task_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_onboarding_rollout_revision_country_ka_type_revision_key" ON "store_onboarding_rollout_revision"("country", "ka_type", "revision");

-- CreateIndex
CREATE INDEX "store_onboarding_rollout_source_task_type_id_idx" ON "store_onboarding_rollout_source"("task_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "so_rollout_source_task_type_key" ON "store_onboarding_rollout_source"("rollout_revision_id", "task_type_id");

-- CreateIndex
CREATE INDEX "so_profile_enabled_scope_idx" ON "store_onboarding_notification_profile"("enabled", "country", "ka_type");

-- CreateIndex
CREATE INDEX "so_profile_logical_activated_idx" ON "store_onboarding_notification_profile"("logical_key", "activated_at");

-- CreateIndex
CREATE INDEX "store_onboarding_notification_profile_webhook_id_idx" ON "store_onboarding_notification_profile"("webhook_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_onboarding_notification_profile_logical_key_revision_key" ON "store_onboarding_notification_profile"("logical_key", "revision");

-- CreateIndex
CREATE INDEX "store_onboarding_notification_template_event_type_idx" ON "store_onboarding_notification_template"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "so_template_profile_event_key" ON "store_onboarding_notification_template"("profile_id", "event_type");

-- CreateIndex
CREATE INDEX "store_onboarding_task_enrollment_decision_task_created_at_idx" ON "store_onboarding_task_enrollment"("decision", "task_created_at");

-- CreateIndex
CREATE INDEX "store_onboarding_task_enrollment_rollout_revision_id_idx" ON "store_onboarding_task_enrollment"("rollout_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_provisioning_brand_id_key" ON "brand_provisioning"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_provisioning_source_task_id_key" ON "brand_provisioning"("source_task_id");

-- CreateIndex
CREATE INDEX "brand_provisioning_status_started_at_idx" ON "brand_provisioning"("status", "started_at");

-- CreateIndex
CREATE INDEX "task_dependency_brand_provisioning_id_status_idx" ON "task_dependency"("brand_provisioning_id", "status");

-- CreateIndex
CREATE INDEX "task_dependency_prerequisite_task_id_status_idx" ON "task_dependency"("prerequisite_task_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependency_task_id_brand_provisioning_id_kind_key" ON "task_dependency"("task_id", "brand_provisioning_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "store_onboarding_request_task_id_key" ON "store_onboarding_request"("task_id");

-- CreateIndex
CREATE INDEX "store_onboarding_request_brand_id_status_created_at_idx" ON "store_onboarding_request"("brand_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "store_onboarding_request_current_stage_status_idx" ON "store_onboarding_request"("current_stage", "status");

-- CreateIndex
CREATE INDEX "store_onboarding_request_estimated_completion_at_idx" ON "store_onboarding_request"("estimated_completion_at");

-- CreateIndex
CREATE INDEX "store_onboarding_request_rollout_revision_id_idx" ON "store_onboarding_request"("rollout_revision_id");

-- CreateIndex
CREATE INDEX "store_onboarding_request_brand_provisioning_id_idx" ON "store_onboarding_request"("brand_provisioning_id");

-- CreateIndex
CREATE INDEX "store_onboarding_request_configuration_brief_assignee_id_cu_idx" ON "store_onboarding_request"("configuration_brief_assignee_id", "current_stage");

-- CreateIndex
CREATE INDEX "store_onboarding_batch_request_id_started_at_idx" ON "store_onboarding_batch"("request_id", "started_at");

-- CreateIndex
CREATE INDEX "store_onboarding_batch_source_step_instance_id_idx" ON "store_onboarding_batch"("source_step_instance_id");

-- CreateIndex
CREATE INDEX "store_onboarding_batch_brand_provisioning_id_idx" ON "store_onboarding_batch"("brand_provisioning_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_onboarding_batch_request_id_ordinal_key" ON "store_onboarding_batch"("request_id", "ordinal");

-- CreateIndex
CREATE INDEX "store_onboarding_unit_request_id_stage_idx" ON "store_onboarding_unit"("request_id", "stage");

-- CreateIndex
CREATE INDEX "store_onboarding_unit_batch_id_stage_idx" ON "store_onboarding_unit"("batch_id", "stage");

-- CreateIndex
CREATE INDEX "store_onboarding_unit_shop_id_idx" ON "store_onboarding_unit"("shop_id");

-- CreateIndex
CREATE INDEX "store_onboarding_unit_configuration_assignee_id_stage_idx" ON "store_onboarding_unit"("configuration_assignee_id", "stage");

-- CreateIndex
CREATE INDEX "store_onboarding_unit_commercial_assignee_id_stage_idx" ON "store_onboarding_unit"("commercial_assignee_id", "stage");

-- CreateIndex
CREATE INDEX "store_onboarding_unit_go_live_assignee_id_stage_idx" ON "store_onboarding_unit"("go_live_assignee_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "store_onboarding_unit_request_id_external_shop_id_key" ON "store_onboarding_unit"("request_id", "external_shop_id");

-- CreateIndex
CREATE INDEX "store_onboarding_transition_unit_id_created_at_idx" ON "store_onboarding_transition"("unit_id", "created_at");

-- CreateIndex
CREATE INDEX "store_onboarding_forecast_snapshot_request_id_calculated_at_idx" ON "store_onboarding_forecast_snapshot"("request_id", "calculated_at");

-- CreateIndex
CREATE INDEX "store_onboarding_go_live_attempt_unit_id_started_at_idx" ON "store_onboarding_go_live_attempt"("unit_id", "started_at");

-- CreateIndex
CREATE INDEX "store_onboarding_go_live_attempt_status_started_at_idx" ON "store_onboarding_go_live_attempt"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_onboarding_outbox_event_event_key_key" ON "store_onboarding_outbox_event"("event_key");

-- CreateIndex
CREATE INDEX "store_onboarding_outbox_event_status_available_at_idx" ON "store_onboarding_outbox_event"("status", "available_at");

-- CreateIndex
CREATE INDEX "store_onboarding_outbox_event_request_id_occurred_at_idx" ON "store_onboarding_outbox_event"("request_id", "occurred_at");

-- CreateIndex
CREATE INDEX "store_onboarding_outbox_event_task_id_occurred_at_idx" ON "store_onboarding_outbox_event"("task_id", "occurred_at");

-- CreateIndex
CREATE INDEX "store_onboarding_notification_delivery_status_next_attempt__idx" ON "store_onboarding_notification_delivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "store_onboarding_notification_delivery_group_key_status_idx" ON "store_onboarding_notification_delivery"("group_key", "status");

-- CreateIndex
CREATE INDEX "store_onboarding_notification_delivery_profile_revision_id__idx" ON "store_onboarding_notification_delivery"("profile_revision_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_onboarding_notification_delivery_outbox_event_id_prof_key" ON "store_onboarding_notification_delivery"("outbox_event_id", "profile_revision_id");

-- AddForeignKey
ALTER TABLE "store_onboarding_control" ADD CONSTRAINT "store_onboarding_control_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_control_revision" ADD CONSTRAINT "store_onboarding_control_revision_control_id_fkey" FOREIGN KEY ("control_id") REFERENCES "store_onboarding_control"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_control_revision" ADD CONSTRAINT "store_onboarding_control_revision_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_rollout_revision" ADD CONSTRAINT "store_onboarding_rollout_revision_notification_profile_id_fkey" FOREIGN KEY ("notification_profile_id") REFERENCES "store_onboarding_notification_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_rollout_revision" ADD CONSTRAINT "store_onboarding_rollout_revision_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_rollout_revision" ADD CONSTRAINT "store_onboarding_rollout_revision_brand_task_type_id_fkey" FOREIGN KEY ("brand_task_type_id") REFERENCES "task_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_rollout_source" ADD CONSTRAINT "store_onboarding_rollout_source_rollout_revision_id_fkey" FOREIGN KEY ("rollout_revision_id") REFERENCES "store_onboarding_rollout_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_rollout_source" ADD CONSTRAINT "store_onboarding_rollout_source_task_type_id_fkey" FOREIGN KEY ("task_type_id") REFERENCES "task_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_notification_profile" ADD CONSTRAINT "store_onboarding_notification_profile_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_notification_profile" ADD CONSTRAINT "store_onboarding_notification_profile_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_notification_template" ADD CONSTRAINT "store_onboarding_notification_template_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "store_onboarding_notification_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_task_enrollment" ADD CONSTRAINT "store_onboarding_task_enrollment_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_task_enrollment" ADD CONSTRAINT "store_onboarding_task_enrollment_rollout_revision_id_fkey" FOREIGN KEY ("rollout_revision_id") REFERENCES "store_onboarding_rollout_revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_provisioning" ADD CONSTRAINT "brand_provisioning_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_provisioning" ADD CONSTRAINT "brand_provisioning_source_task_id_fkey" FOREIGN KEY ("source_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_prerequisite_task_id_fkey" FOREIGN KEY ("prerequisite_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_brand_provisioning_id_fkey" FOREIGN KEY ("brand_provisioning_id") REFERENCES "brand_provisioning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_request" ADD CONSTRAINT "store_onboarding_request_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_request" ADD CONSTRAINT "store_onboarding_request_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_request" ADD CONSTRAINT "store_onboarding_request_rollout_revision_id_fkey" FOREIGN KEY ("rollout_revision_id") REFERENCES "store_onboarding_rollout_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_request" ADD CONSTRAINT "store_onboarding_request_brand_provisioning_id_fkey" FOREIGN KEY ("brand_provisioning_id") REFERENCES "brand_provisioning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_request" ADD CONSTRAINT "store_onboarding_request_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_request" ADD CONSTRAINT "store_onboarding_request_configuration_prepared_by_id_fkey" FOREIGN KEY ("configuration_prepared_by_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_request" ADD CONSTRAINT "store_onboarding_request_configuration_brief_assignee_id_fkey" FOREIGN KEY ("configuration_brief_assignee_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_batch" ADD CONSTRAINT "store_onboarding_batch_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "store_onboarding_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_batch" ADD CONSTRAINT "store_onboarding_batch_source_step_instance_id_fkey" FOREIGN KEY ("source_step_instance_id") REFERENCES "step_instance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_batch" ADD CONSTRAINT "store_onboarding_batch_brand_provisioning_id_fkey" FOREIGN KEY ("brand_provisioning_id") REFERENCES "brand_provisioning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_unit" ADD CONSTRAINT "store_onboarding_unit_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "store_onboarding_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_unit" ADD CONSTRAINT "store_onboarding_unit_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "store_onboarding_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_unit" ADD CONSTRAINT "store_onboarding_unit_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_unit" ADD CONSTRAINT "store_onboarding_unit_configuration_assignee_id_fkey" FOREIGN KEY ("configuration_assignee_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_unit" ADD CONSTRAINT "store_onboarding_unit_commercial_assignee_id_fkey" FOREIGN KEY ("commercial_assignee_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_unit" ADD CONSTRAINT "store_onboarding_unit_go_live_assignee_id_fkey" FOREIGN KEY ("go_live_assignee_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_unit" ADD CONSTRAINT "store_onboarding_unit_audited_by_id_fkey" FOREIGN KEY ("audited_by_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_transition" ADD CONSTRAINT "store_onboarding_transition_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "store_onboarding_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_transition" ADD CONSTRAINT "store_onboarding_transition_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_forecast_snapshot" ADD CONSTRAINT "store_onboarding_forecast_snapshot_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "store_onboarding_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_go_live_attempt" ADD CONSTRAINT "store_onboarding_go_live_attempt_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "store_onboarding_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_go_live_attempt" ADD CONSTRAINT "store_onboarding_go_live_attempt_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_outbox_event" ADD CONSTRAINT "store_onboarding_outbox_event_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "store_onboarding_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_outbox_event" ADD CONSTRAINT "store_onboarding_outbox_event_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_outbox_event" ADD CONSTRAINT "store_onboarding_outbox_event_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "store_onboarding_unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_notification_delivery" ADD CONSTRAINT "store_onboarding_notification_delivery_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "store_onboarding_outbox_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_onboarding_notification_delivery" ADD CONSTRAINT "store_onboarding_notification_delivery_profile_revision_id_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "store_onboarding_notification_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
