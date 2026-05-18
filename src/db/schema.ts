import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export const tenantLimits = sqliteTable("tenant_limits", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id),
  requestsPerMinute: integer("requests_per_minute").notNull().default(60),
  budgetUsdMonthly: real("budget_usd_monthly").notNull().default(10.0),
  budgetUsedUsd: real("budget_used_usd").notNull().default(0.0),
  budgetResetAt: integer("budget_reset_at", { mode: "timestamp" }).notNull(),
  // JSON arrays stored as text: ["groq", "gemini"] or null for all
  allowedProviders: text("allowed_providers"),
  // JSON array of model names or null for all
  allowedModels: text("allowed_models"),
  // "cost" | "latency" | "failover"
  routingPolicy: text("routing_policy").notNull().default("cost"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const requests = sqliteTable("requests", {
  id: text("id").primaryKey(),
  traceId: text("trace_id").notNull(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  requestedModel: text("requested_model").notNull(),
  routedProvider: text("routed_provider"),
  routedModel: text("routed_model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  latencyMs: integer("latency_ms"),
  ttfbMs: integer("ttfb_ms"),
  // "success" | "error" | "timeout" | "circuit_open" | "cached" | "rate_limited" | "budget_exceeded"
  status: text("status").notNull(),
  errorCode: text("error_code"),
  cached: integer("cached", { mode: "boolean" }).notNull().default(false),
  streaming: integer("streaming", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const providerHealth = sqliteTable("provider_health", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull().unique(),
  // "closed" | "open" | "half_open"
  state: text("state").notNull().default("closed"),
  failureCount: integer("failure_count").notNull().default(0),
  lastFailureAt: integer("last_failure_at", { mode: "timestamp" }),
  openedAt: integer("opened_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type TenantLimits = typeof tenantLimits.$inferSelect;
export type Request = typeof requests.$inferSelect;
export type ProviderHealth = typeof providerHealth.$inferSelect;
