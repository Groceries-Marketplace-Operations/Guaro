ALTER TABLE "targeted_menu_rule"
ADD COLUMN "merge_policy" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "targeted_menu_rule"
ADD CONSTRAINT "targeted_menu_rule_merge_policy_check"
CHECK ("merge_policy" IN (0, 1));
