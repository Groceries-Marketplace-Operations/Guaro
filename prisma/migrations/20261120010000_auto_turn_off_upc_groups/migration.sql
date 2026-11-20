-- Additive metadata: the existing upcs column continues to drive stock updates.
ALTER TABLE "auto_turn_off_rule" ADD COLUMN "upc_groups" JSONB;
ALTER TABLE "auto_turn_off_rule" ADD COLUMN "config_version" INTEGER NOT NULL DEFAULT 0;
