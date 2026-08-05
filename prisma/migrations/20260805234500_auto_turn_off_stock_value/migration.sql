ALTER TABLE "auto_turn_off_rule"
ADD COLUMN "stock_value" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "auto_turn_off_rule"
ADD CONSTRAINT "auto_turn_off_rule_stock_value_nonnegative"
CHECK ("stock_value" >= 0);
