-- Intentionally no legacy backfill in the deploy path. Updating the central
-- request table would rewrite a large number of rows and retain locks while
-- production webhooks are arriving. The application derives the legacy source
-- from remote_shop_validated/event data, while every new writer stores an
-- explicit source. An online, batched backfill can be performed separately.
--
-- Strict source/validation CHECK constraints are also deferred because the
-- previous backend can still write during the zero-downtime migration window.
SELECT 1;
