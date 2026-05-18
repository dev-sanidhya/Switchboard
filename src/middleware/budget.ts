import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/client.js";
import { tenantLimits } from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { logRequest } from "../observability/request-log.js";

export async function budgetMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const ctx = req.tenantCtx;
  if (!ctx) return;

  const { limits } = ctx;

  // Auto-reset budget if we've crossed into a new month
  const now = new Date();
  if (limits.budgetResetAt < now) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await db
      .update(tenantLimits)
      .set({ budgetUsedUsd: 0, budgetResetAt: nextReset, updatedAt: now })
      .where(eq(tenantLimits.id, limits.id));
    limits.budgetUsedUsd = 0;
    limits.budgetResetAt = nextReset;
  }

  if (limits.budgetUsedUsd >= limits.budgetUsdMonthly) {
    // Persist the rejection so /metrics sees it.
    const body = req.body as { model?: string; stream?: boolean } | undefined;
    await logRequest({
      traceId: req.traceId ?? "unknown",
      tenantId: ctx.tenant.id,
      requestedModel: body?.model ?? "unknown",
      status: "budget_exceeded",
      errorCode: "402",
      streaming: Boolean(body?.stream),
    });

    return reply.code(402).send({
      error: "Monthly budget exhausted",
      budget_usd: limits.budgetUsdMonthly,
      used_usd: limits.budgetUsedUsd,
      resets_at: limits.budgetResetAt,
    });
  }
}

/**
 * Atomically deduct cost from tenant budget using a conditional SQL UPDATE.
 * The WHERE clause ensures budget_used + cost <= budget_cap at the DB level,
 * closing the TOCTOU race between the pre-flight check and the deduction.
 *
 * Returns { overBudget: true } if concurrent requests raced past the cap.
 * Cost was already incurred at the provider; we clamp the DB to the monthly
 * cap so the accounting stays consistent and the next pre-flight check fires.
 */
export async function deductBudget(
  tenantId: string,
  limitId: string,
  costUsd: number,
): Promise<{ overBudget: boolean }> {
  const updated = await db
    .update(tenantLimits)
    .set({
      budgetUsedUsd: sql`${tenantLimits.budgetUsedUsd} + ${costUsd}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tenantLimits.id, limitId),
        sql`${tenantLimits.budgetUsedUsd} + ${costUsd} <= ${tenantLimits.budgetUsdMonthly}`,
      ),
    )
    .returning({ budgetUsedUsd: tenantLimits.budgetUsedUsd });

  if (updated.length === 0) {
    // Race condition: another concurrent request pushed us past the cap.
    // Clamp to the monthly cap so the next pre-flight check correctly fires 402.
    await db
      .update(tenantLimits)
      .set({ budgetUsedUsd: sql`${tenantLimits.budgetUsdMonthly}`, updatedAt: new Date() })
      .where(eq(tenantLimits.id, limitId));
    return { overBudget: true };
  }

  return { overBudget: false };
}
