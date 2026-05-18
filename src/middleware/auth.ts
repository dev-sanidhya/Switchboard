import type { FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "crypto";
import { db } from "../db/client.js";
import { apiKeys, tenants, tenantLimits } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import type { TenantLimits, Tenant } from "../db/schema.js";

export interface TenantContext {
  tenant: Tenant;
  limits: TenantLimits;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantCtx?: TenantContext;
    traceId?: string;
  }
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Missing or invalid Authorization header" });
  }

  const rawKey = authHeader.slice(7);
  const keyHash = hashKey(rawKey);

  const keyRow = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)),
  });

  if (!keyRow) {
    return reply.code(401).send({ error: "Invalid API key" });
  }

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, keyRow.tenantId),
  });

  const limits = await db.query.tenantLimits.findFirst({
    where: eq(tenantLimits.tenantId, keyRow.tenantId),
  });

  if (!tenant || !limits) {
    return reply.code(500).send({ error: "Tenant configuration missing" });
  }

  req.tenantCtx = { tenant, limits };
}
