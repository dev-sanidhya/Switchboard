-- Composite index for the metrics endpoint query pattern:
-- WHERE tenant_id = ? AND created_at > ?  GROUP BY routed_provider, routed_model
-- Without this index, every metrics query does a full table scan on requests.
CREATE INDEX IF NOT EXISTS `idx_requests_tenant_time`
  ON `requests` (`tenant_id`, `created_at` DESC);
--> statement-breakpoint

-- Secondary index for status-based filtering (error rate queries)
CREATE INDEX IF NOT EXISTS `idx_requests_tenant_status`
  ON `requests` (`tenant_id`, `status`);
