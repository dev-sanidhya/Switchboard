import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/client.js";
import { tenantLimits } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

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
    return reply.code(402).send({
      error: "Monthly budget exhausted",
      budget_usd: limits.budgetUsdMonthly,
      used_usd: limits.budgetUsedUsd,
      resets_at: limits.budgetResetAt,
    });
  }
}

export async function deductBudget(tenantId: string, limitId: string, costUsd: number) {
  await db
    .update(tenantLimits)
    .set({
      budgetUsedUsd: sql`${tenantLimits.budgetUsedUsd} + ${costUsd}`,
      updatedAt: new Date(),
    })
    .where(eq(tenantLimits.id, limitId));
}
