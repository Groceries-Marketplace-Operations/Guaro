-- Support the centralized webhook log page without scanning and sorting the
-- complete request table on every refresh. No payloads or credentials are
-- included in either index.
CREATE INDEX "didi_order_webhook_request_created_at_id_idx"
  ON "didi_order_webhook_request"("created_at", "id");

CREATE INDEX "didi_order_webhook_request_outcome_created_at_idx"
  ON "didi_order_webhook_request"("outcome", "created_at");
