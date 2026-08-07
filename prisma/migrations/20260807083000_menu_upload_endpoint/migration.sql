ALTER TABLE "targeted_menu_rule"
ADD COLUMN "upload_endpoint" TEXT NOT NULL DEFAULT 'uploadGrocery';

ALTER TABLE "targeted_menu_rule"
ADD CONSTRAINT "targeted_menu_rule_upload_endpoint_check"
CHECK ("upload_endpoint" IN ('uploadGrocery', 'updateItemsync'));

ALTER TABLE "menu_copy_execution"
ADD COLUMN "upload_endpoint" TEXT NOT NULL DEFAULT 'uploadGrocery';

ALTER TABLE "menu_copy_execution"
ADD CONSTRAINT "menu_copy_execution_upload_endpoint_check"
CHECK ("upload_endpoint" IN ('uploadGrocery', 'updateItemsync'));
