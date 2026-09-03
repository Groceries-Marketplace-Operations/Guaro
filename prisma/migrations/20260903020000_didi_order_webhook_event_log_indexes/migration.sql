-- Keep the operational log pages bounded to one application as the audit
-- table grows. These indexes contain identifiers/status/timestamps only.
CREATE INDEX "didi_order_webhook_event_application_id_created_at_idx"
  ON "didi_order_webhook_event"("application_id", "created_at");

CREATE INDEX "didi_order_webhook_event_application_id_status_created_at_idx"
  ON "didi_order_webhook_event"("application_id", "status", "created_at");
