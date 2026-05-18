import { db } from "../db/client.js";
import { requests } from "../db/schema.js";
import { and, eq, gte, sql } from "drizzle-orm";

export type MetricsWindow = "1h" | "24h" | "7d";

const WINDOW_MS: Record<MetricsWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

// Classification of request outcomes. Anything not in SUCCESS counts toward
// the error rate. Previously rate_limited and budget_exceeded were silently
// excluded from errors, understating the actual failure surface to operators.
const SUCCESS_STATUSES = new Set(["success", "cached"]);
const ERROR_STATUSES = new Set([
  "error",
  "timeout",
  "rate_limited",
  "budget_exceeded",
]);

export async function getMetrics(tenantId: string | null, window: MetricsWindow) {
  const since = new Date(Date.now() - WINDOW_MS[window]);

  const conditions = tenantId
    ? and(eq(requests.tenantId, tenantId), gte(requests.createdAt, since))
    : gte(requests.createdAt, since);

  const rows = await db
    .select()
    .from(requests)
    .where(conditions);

  const total = rows.length;
  const success = rows.filter((r) => SUCCESS_STATUSES.has(r.status)).length;
  const errors = rows.filter((r) => ERROR_STATUSES.has(r.status)).length;
  const cached = rows.filter((r) => r.cached).length;
  const rateLimited = rows.filter((r) => r.status === "rate_limited").length;
  const budgetExceeded = rows.filter((r) => r.status === "budget_exceeded").length;

  const latencies = rows
    .filter((r) => r.latencyMs != null)
    .map((r) => r.latencyMs!)
    .sort((a, b) => a - b);

  const totalInputTokens = rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const totalOutputTokens = rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  // Per-provider breakdown. Gateway-layer rejections (rate_limited, budget_exceeded)
  // have no routed_provider; they land under "gateway" in the breakdown.
  const byProvider: Record<string, { requests: number; cost: number; errors: number }> = {};
  for (const r of rows) {
    const p = r.routedProvider ?? "gateway";
    if (!byProvider[p]) byProvider[p] = { requests: 0, cost: 0, errors: 0 };
    byProvider[p].requests++;
    byProvider[p].cost += r.costUsd ?? 0;
    if (ERROR_STATUSES.has(r.status)) byProvider[p].errors++;
  }

  // Per-model breakdown
  const byModel: Record<string, { requests: number; cost: number; input_tokens: number; output_tokens: number }> = {};
  for (const r of rows) {
    const m = r.routedModel ?? r.requestedModel;
    if (!byModel[m]) byModel[m] = { requests: 0, cost: 0, input_tokens: 0, output_tokens: 0 };
    byModel[m].requests++;
    byModel[m].cost += r.costUsd ?? 0;
    byModel[m].input_tokens += r.inputTokens ?? 0;
    byModel[m].output_tokens += r.outputTokens ?? 0;
  }

  return {
    tenant: tenantId ?? "all",
    window,
    since: since.toISOString(),
    requests: {
      total,
      success,
      errors,
      cached,
      rate_limited: rateLimited,
      budget_exceeded: budgetExceeded,
    },
    latency: percentiles(latencies),
    tokens: { input: totalInputTokens, output: totalOutputTokens },
    cost_usd: Math.round(totalCost * 1e6) / 1e6,
    by_provider: byProvider,
    by_model: byModel,
  };
}

function percentiles(sorted: number[]): { p50: number; p95: number; p99: number } | null {
  if (sorted.length === 0) return null;
  const p = (pct: number) => sorted[Math.floor((sorted.length - 1) * pct)];
  return { p50: p(0.5), p95: p(0.95), p99: p(0.99) };
}
