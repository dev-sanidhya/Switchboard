import { db } from "../db/client.js";
import { requests } from "../db/schema.js";
import { generateId } from "./tracer.js";

/**
 * Persist the outcome of a /v1/chat/completions request to the requests table.
 *
 * Called from:
 *   - chat.ts on success / provider error / no-eligible-provider
 *   - rate-limit middleware on 429 (status="rate_limited")
 *   - budget middleware on 402 (status="budget_exceeded")
 *
 * Auth failures are intentionally NOT logged here. They have no tenant_id
 * (the FK requires one), they're attacker noise rather than tenant usage,
 * and they pollute the metrics surface. They go to structured logs only.
 *
 * Logging itself is best-effort: a DB write failure here must never break
 * the user-facing request flow.
 */
export async function logRequest(data: {
  traceId: string;
  tenantId: string;
  requestedModel: string;
  routedProvider?: string;
  routedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  ttfbMs?: number;
  status: string;
  errorCode?: string;
  cached?: boolean;
  streaming: boolean;
}) {
  try {
    await db.insert(requests).values({
      id: generateId(),
      traceId: data.traceId,
      tenantId: data.tenantId,
      requestedModel: data.requestedModel,
      routedProvider: data.routedProvider ?? null,
      routedModel: data.routedModel ?? null,
      inputTokens: data.inputTokens ?? null,
      outputTokens: data.outputTokens ?? null,
      costUsd: data.costUsd ?? null,
      latencyMs: data.latencyMs ?? null,
      ttfbMs: data.ttfbMs ?? null,
      status: data.status,
      errorCode: data.errorCode ?? null,
      cached: data.cached ?? false,
      streaming: data.streaming,
      createdAt: new Date(),
    });
  } catch {
    // Non-fatal: logging failure must not affect the request
  }
}
