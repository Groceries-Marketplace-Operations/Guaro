-- CreateEnum
CREATE TYPE "Country" AS ENUM ('CO', 'MX', 'CR');

-- CreateEnum
CREATE TYPE "AccountRol" AS ENUM ('user', 'bpo', 'admin', 'super_admin', 'director');

-- CreateEnum
CREATE TYPE "TipoEjecucion" AS ENUM ('manual_externo', 'manual_interno', 'automatico');

-- CreateEnum
CREATE TYPE "EstrategiaAsignacion" AS ENUM ('fijo', 'round_robin', 'por_peso');

-- CreateEnum
CREATE TYPE "AsignacionModo" AS ENUM ('fijo', 'round_robin');

-- CreateEnum
CREATE TYPE "FormFieldTipo" AS ENUM ('link', 'link_spreadsheet', 'texto', 'numero', 'select', 'select_brand', 'select_store');

-- CreateEnum
CREATE TYPE "WebhookEvento" AS ENUM ('al_iniciar', 'al_terminar', 'al_fallar');

-- CreateEnum
CREATE TYPE "TaskEstado" AS ENUM ('scheduled', 'pending', 'assigned', 'in_progress', 'failed', 'done');

-- CreateEnum
CREATE TYPE "StepEstado" AS ENUM ('pending', 'in_progress', 'blocked', 'failed', 'done');

-- CreateEnum
CREATE TYPE "StepMotivoFallo" AS ENUM ('system_timed_out', 'bpo_timed_out', 'sin_bpo', 'error_handler');

-- CreateEnum
CREATE TYPE "KaType" AS ENUM ('KA', 'CKA', 'SME');

-- CreateEnum
CREATE TYPE "MenuIntegration" AS ENUM ('api', 'api_whitelist', 'sftp', 'spreadsheets', 'bapp');

-- CreateEnum
CREATE TYPE "PickingMode" AS ENUM ('merchant_picking_bapp', 'merchant_picking_dapp', 'dos_en_uno');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('food_mode', 'prepaid_card', 'qr_code');

-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('lead', 'application', 'integrated', 'online');

-- CreateEnum
CREATE TYPE "DiaSemana" AS ENUM ('lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo');

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "google_sub" TEXT,
    "roles" "AccountRol"[],
    "section_id" UUID,
    "carga" INTEGER NOT NULL DEFAULT 0,
    "contador_rr" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_type" (
    "id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "programable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "task_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handler" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "handler_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_definition" (
    "id" UUID NOT NULL,
    "task_type_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "tipo_ejecucion" "TipoEjecucion" NOT NULL,
    "accion" TEXT,
    "estrategia_asignacion" "EstrategiaAsignacion" NOT NULL,
    "peso" INTEGER NOT NULL DEFAULT 1,
    "handler_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "step_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_definition_account" (
    "step_definition_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,

    CONSTRAINT "step_definition_account_pkey" PRIMARY KEY ("step_definition_id","account_id")
);

-- CreateTable
CREATE TABLE "form_field" (
    "id" UUID NOT NULL,
    "task_type_id" UUID NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "tipo" "FormFieldTipo" NOT NULL,
    "requerido" BOOLEAN NOT NULL DEFAULT false,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "opciones" JSONB,
    "orden" INTEGER NOT NULL,
    "filtra_por_field" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "es_alertas" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_webhook" (
    "id" UUID NOT NULL,
    "step_definition_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "eventos" "WebhookEvento"[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "step_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application" (
    "id" UUID NOT NULL,
    "app_id" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "country" "Country" NOT NULL,
    "app_secret" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand" (
    "id" UUID NOT NULL,
    "brand_id" TEXT NOT NULL,
    "brand_name" TEXT NOT NULL,
    "country" "Country" NOT NULL,
    "ka_type" "KaType" NOT NULL,
    "category" TEXT,
    "menu_integration" "MenuIntegration",
    "picking_mode" "PickingMode",
    "payment_mode" "PaymentMode",
    "responsable_id" UUID NOT NULL,
    "application_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_webhook" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop" (
    "id" UUID NOT NULL,
    "shop_id" TEXT NOT NULL,
    "app_shop_id" TEXT NOT NULL,
    "brand_id" UUID NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "city" TEXT,
    "status" "ShopStatus" NOT NULL DEFAULT 'lead',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "dia" "DiaSemana" NOT NULL,
    "apertura" TIME NOT NULL,
    "cierre" TIME NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_assignment_rule" (
    "id" UUID NOT NULL,
    "ka_type" "KaType" NOT NULL,
    "country" "Country" NOT NULL,
    "modo" "AsignacionModo" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_assignment_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_assignment_rule_account" (
    "rule_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,

    CONSTRAINT "brand_assignment_rule_account_pkey" PRIMARY KEY ("rule_id","account_id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "task_type_id" UUID NOT NULL,
    "brand_id" UUID,
    "created_by" UUID NOT NULL,
    "estado" "TaskEstado" NOT NULL DEFAULT 'pending',
    "programado_inicio" TIMESTAMP(3),
    "programado_fin" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_shop" (
    "task_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,

    CONSTRAINT "task_shop_pkey" PRIMARY KEY ("task_id","shop_id")
);

-- CreateTable
CREATE TABLE "step_instance" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "step_definition_id" UUID NOT NULL,
    "estado" "StepEstado" NOT NULL DEFAULT 'pending',
    "asignado_id" UUID,
    "resultado" JSONB,
    "nota" TEXT,
    "motivo_fallo" "StepMotivoFallo",
    "completado_en" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "step_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_value" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "form_field_id" UUID NOT NULL,
    "valor" TEXT,
    "brand_id" UUID,
    "shop_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "rol" "AccountRol" NOT NULL,
    "section_id" UUID,
    "created_by" UUID NOT NULL,
    "account_id" UUID,
    "used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_email_key" ON "account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "account_google_sub_key" ON "account"("google_sub");

-- CreateIndex
CREATE INDEX "account_section_id_idx" ON "account"("section_id");

-- CreateIndex
CREATE INDEX "task_type_section_id_idx" ON "task_type"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "handler_nombre_key" ON "handler"("nombre");

-- CreateIndex
CREATE INDEX "step_definition_task_type_id_idx" ON "step_definition"("task_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "step_definition_task_type_id_orden_key" ON "step_definition"("task_type_id", "orden");

-- CreateIndex
CREATE INDEX "form_field_task_type_id_idx" ON "form_field"("task_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_field_task_type_id_orden_key" ON "form_field"("task_type_id", "orden");

-- CreateIndex
CREATE INDEX "step_webhook_step_definition_id_idx" ON "step_webhook"("step_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "step_webhook_step_definition_id_webhook_id_key" ON "step_webhook"("step_definition_id", "webhook_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_app_id_key" ON "application"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_id_country_key" ON "application"("id", "country");

-- CreateIndex
CREATE UNIQUE INDEX "brand_brand_id_key" ON "brand"("brand_id");

-- CreateIndex
CREATE INDEX "brand_responsable_id_idx" ON "brand"("responsable_id");

-- CreateIndex
CREATE INDEX "brand_application_id_idx" ON "brand"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_webhook_brand_id_webhook_id_key" ON "brand_webhook"("brand_id", "webhook_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_shop_id_key" ON "shop"("shop_id");

-- CreateIndex
CREATE INDEX "shop_brand_id_idx" ON "shop"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_brand_id_app_shop_id_key" ON "shop"("brand_id", "app_shop_id");

-- CreateIndex
CREATE INDEX "schedule_shop_id_idx" ON "schedule"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_assignment_rule_ka_type_country_key" ON "brand_assignment_rule"("ka_type", "country");

-- CreateIndex
CREATE INDEX "task_task_type_id_idx" ON "task"("task_type_id");

-- CreateIndex
CREATE INDEX "task_brand_id_idx" ON "task"("brand_id");

-- CreateIndex
CREATE INDEX "task_created_by_idx" ON "task"("created_by");

-- CreateIndex
CREATE INDEX "task_estado_idx" ON "task"("estado");

-- CreateIndex
CREATE INDEX "step_instance_task_id_idx" ON "step_instance"("task_id");

-- CreateIndex
CREATE INDEX "step_instance_asignado_id_idx" ON "step_instance"("asignado_id");

-- CreateIndex
CREATE INDEX "form_value_task_id_idx" ON "form_value"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_key" ON "invitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_account_id_key" ON "invitation"("account_id");

-- CreateIndex
CREATE INDEX "invitation_section_id_idx" ON "invitation"("section_id");

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_type" ADD CONSTRAINT "task_type_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_definition" ADD CONSTRAINT "step_definition_task_type_id_fkey" FOREIGN KEY ("task_type_id") REFERENCES "task_type"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_definition" ADD CONSTRAINT "step_definition_handler_id_fkey" FOREIGN KEY ("handler_id") REFERENCES "handler"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_definition_account" ADD CONSTRAINT "step_definition_account_step_definition_id_fkey" FOREIGN KEY ("step_definition_id") REFERENCES "step_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_definition_account" ADD CONSTRAINT "step_definition_account_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_field" ADD CONSTRAINT "form_field_task_type_id_fkey" FOREIGN KEY ("task_type_id") REFERENCES "task_type"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_field" ADD CONSTRAINT "form_field_filtra_por_field_fkey" FOREIGN KEY ("filtra_por_field") REFERENCES "form_field"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_webhook" ADD CONSTRAINT "step_webhook_step_definition_id_fkey" FOREIGN KEY ("step_definition_id") REFERENCES "step_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_webhook" ADD CONSTRAINT "step_webhook_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_responsable_id_fkey" FOREIGN KEY ("responsable_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_webhook" ADD CONSTRAINT "brand_webhook_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_webhook" ADD CONSTRAINT "brand_webhook_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop" ADD CONSTRAINT "shop_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop" ADD CONSTRAINT "shop_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_assignment_rule_account" ADD CONSTRAINT "brand_assignment_rule_account_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "brand_assignment_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_assignment_rule_account" ADD CONSTRAINT "brand_assignment_rule_account_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_task_type_id_fkey" FOREIGN KEY ("task_type_id") REFERENCES "task_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_shop" ADD CONSTRAINT "task_shop_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_shop" ADD CONSTRAINT "task_shop_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_instance" ADD CONSTRAINT "step_instance_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_instance" ADD CONSTRAINT "step_instance_step_definition_id_fkey" FOREIGN KEY ("step_definition_id") REFERENCES "step_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_instance" ADD CONSTRAINT "step_instance_asignado_id_fkey" FOREIGN KEY ("asignado_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_value" ADD CONSTRAINT "form_value_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_value" ADD CONSTRAINT "form_value_form_field_id_fkey" FOREIGN KEY ("form_field_id") REFERENCES "form_field"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_value" ADD CONSTRAINT "form_value_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_value" ADD CONSTRAINT "form_value_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
