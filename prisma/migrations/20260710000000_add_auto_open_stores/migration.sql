-- CreateEnum
CREATE TYPE "AutoOpenEstado" AS ENUM ('pending', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "auto_open_pool" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country" "Country" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "execution_hours" INTEGER[],
    "webhook_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "auto_open_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_open_pool_brand" (
    "pool_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,

    CONSTRAINT "auto_open_pool_brand_pkey" PRIMARY KEY ("pool_id","brand_id")
);

-- CreateTable
CREATE TABLE "auto_open_execution" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "status" "AutoOpenEstado" NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "total_shops" INTEGER NOT NULL DEFAULT 0,
    "shops_opened" INTEGER NOT NULL DEFAULT 0,
    "logs" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_open_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auto_open_execution_pool_id_idx" ON "auto_open_execution"("pool_id");

-- AddForeignKey
ALTER TABLE "auto_open_pool" ADD CONSTRAINT "auto_open_pool_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_open_pool_brand" ADD CONSTRAINT "auto_open_pool_brand_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "auto_open_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_open_pool_brand" ADD CONSTRAINT "auto_open_pool_brand_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_open_execution" ADD CONSTRAINT "auto_open_execution_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "auto_open_pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
