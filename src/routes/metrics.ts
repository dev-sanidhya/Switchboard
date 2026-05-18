import type { FastifyInstance } from "fastify";
import { getMetrics } from "../observability/metrics.js";
import type { MetricsWindow } from "../observability/metrics.js";
import { db } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { and, eq, isNull } from "drizzle-orm";
import { hashKey } from "../middleware/auth.js";

const VALID_WINDOWS = new Set<MetricsWindow>(["1h", "24h", "7d"]);

/**
 * Auth resolution for /metrics:
 *  1. X-Admin-Key matching ADMIN_API_KEY -> admin scope (can query any tenant or "all").
 *  2. Authorization: Bearer sk-... matching a non-revoked api_key -> tenant scope
 *     (response is forcibly scoped to that tenant_id regardless of ?tenant=).
 *  3. Otherwise -> 401.
 *
 * Previous version had no auth at all -- any unauthenticated caller could read
 * every tenant's spend, which is a multi-tenant isolation failure.
 */
async function resolveScope(
  req: { headers: Record<string, string | string[] | undefined> },
): Promise<{ kind: "admin" } | { kind: "tenant"; tenantId: string } | { kind: "unauth" }> {
  const adminKey = process.env.ADMIN_API_KEY;
  const adminHeader = req.headers["x-admin-key"];
  if (adminKey && adminHeader === adminKey) {
    return { kind: "admin" };
  }

  const authHeader = req.headers["authorization"];
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (auth?.startsWith("Bearer ")) {
    const keyHash = hashKey(auth.slice(7));
    const keyRow = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)),
    });
    if (keyRow) return { kind: "tenant", tenantId: keyRow.tenantId };
  }

  return { kind: "unauth" };
}

export async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get("/metrics", async (req, reply) => {
    const scope = await resolveScope(req);
    if (scope.kind === "unauth") {
      return reply.code(401).send({
        error: "Authentication required. Provide a tenant Bearer token or X-Admin-Key.",
      });
    }

    const query = req.query as Record<string, string>;
    const requestedTenant = query.tenant ?? null;
    const window = (query.window ?? "24h") as MetricsWindow;

    if (!VALID_WINDOWS.has(window)) {
      return reply.code(400).send({ error: "window must be one of: 1h, 24h, 7d" });
    }

    // Tenant-scope callers can never see another tenant's data. ?tenant= is
    // ignored if it doesn't match their own ID -- we silently force their scope.
    let effectiveTenantId: string | null;
    if (scope.kind === "tenant") {
      if (requestedTenant && requestedTenant !== scope.tenantId) {
        return reply.code(403).send({ error: "Cannot query metrics for another tenant" });
      }
      effectiveTenantId = scope.tenantId;
    } else {
      // admin: may query any specific tenant, or omit ?tenant= for global view
      effectiveTenantId = requestedTenant;
    }

    const data = await getMetrics(effectiveTenantId, window);
    return reply.send(data);
  });
}
