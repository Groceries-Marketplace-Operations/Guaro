ALTER TABLE "auto_fetch_pool"
ADD COLUMN "execution_times" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "auto_fetch_pool"
SET "execution_times" = ARRAY[
  LPAD("execution_hour"::TEXT, 2, '0') || ':' || LPAD("execution_minute"::TEXT, 2, '0')
]
WHERE "kind" = 'menu';
