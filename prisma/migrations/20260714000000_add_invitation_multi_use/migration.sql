-- AlterTable
ALTER TABLE "invitation" ADD COLUMN "max_uses" INTEGER;
ALTER TABLE "invitation" ADD COLUMN "use_count" INTEGER NOT NULL DEFAULT 0;
