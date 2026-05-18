import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { tenants, apiKeys, tenantLimits } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { generateId } from "../observability/tracer.js";
import { hashKey } from "../middleware/auth.js";
import { randomBytes } from "crypto";
import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";

const createTenantSchema = z.object({
  name: z.string().min(1),
  requests_per_minute: z.number().int().positive().default(60),
  budget_usd_monthly: z.number().positive().default(10),
  allowed_providers: z.array(z.string()).optional(),
  allowed_models: z.array(z.string()).optional(),
  routing_policy: z.enum(["cost", "failover"]).default("cost"),
});

export async function adminRoutes(fastify: FastifyInstance) {
  if (!config.ADMIN_API_KEY) {
    logger.warn(
      "ADMIN_API_KEY is not set — admin routes are unauthenticated. Set this in production.",
    );
  }

  // Protect all admin routes when ADMIN_API_KEY is configured
  fastify.addHook("preHandler", async (req, reply) => {
    if (!config.ADMIN_API_KEY) return;
    const provided = req.headers["x-admin-key"];
    if (provided !== config.ADMIN_API_KEY) {
      return reply.code(401).send({ error: "Missing or invalid X-Admin-Key header" });
    }
  });

  // Create tenant + initial API key
  fastify.post("/admin/tenants", async (req, reply) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const data = parsed.data;
    const now = new Date();
    const tenantId = generateId();
    const limitId = generateId();
    const keyId = generateId();
    const rawKey = `sk-${randomBytes(24).toString("hex")}`;
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    await db.insert(tenants).values({ id: tenantId, name: data.name, createdAt: now, updatedAt: now });
    await db.insert(tenantLimits).values({
      id: limitId,
      tenantId,
      requestsPerMinute: data.requests_per_minute,
      budgetUsdMonthly: data.budget_usd_monthly,
      budgetUsedUsd: 0,
      budgetResetAt: nextReset,
      allowedProviders: data.allowed_providers ? JSON.stringify(data.allowed_providers) : null,
      allowedModels: data.allowed_models ? JSON.stringify(data.allowed_models) : null,
      routingPolicy: data.routing_policy,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(apiKeys).values({
      id: keyId,
      tenantId,
      keyHash: hashKey(rawKey),
      label: "default",
      createdAt: now,
      revokedAt: null,
    });

    return reply.code(201).send({
      tenant_id: tenantId,
      name: data.name,
      api_key: rawKey, // returned once, never stored in plaintext
    });
  });

  // List tenants
  fastify.get("/admin/tenants", async (_req, reply) => {
    const rows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        createdAt: tenants.createdAt,
      })
      .from(tenants);
    return reply.send(rows);
  });

  // Get tenant details with limits
  fastify.get("/admin/tenants/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return reply.code(404).send({ error: "Tenant not found" });

    const limits = await db.query.tenantLimits.findFirst({
      where: eq(tenantLimits.tenantId, id),
    });

    return reply.send({ ...tenant, limits });
  });

  // List API keys for a tenant (hashes only — raw keys are never stored)
  fastify.get("/admin/tenants/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return reply.code(404).send({ error: "Tenant not found" });

    const keys = await db
      .select({
        id: apiKeys.id,
        label: apiKeys.label,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, id));

    return reply.send(keys);
  });

  // Issue a new API key for an existing tenant
  fastify.post("/admin/tenants/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { label?: string };

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return reply.code(404).send({ error: "Tenant not found" });

    const rawKey = `sk-${randomBytes(24).toString("hex")}`;
    const now = new Date();
    await db.insert(apiKeys).values({
      id: generateId(),
      tenantId: id,
      keyHash: hashKey(rawKey),
      label: body?.label ?? null,
      createdAt: now,
      revokedAt: null,
    });

    return reply.code(201).send({ api_key: rawKey });
  });

  // Revoke an API key (soft-delete: sets revoked_at, auth middleware rejects it)
  fastify.delete("/admin/tenants/:id/keys/:keyId", async (req, reply) => {
    const { id, keyId } = req.params as { id: string; keyId: string };

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return reply.code(404).send({ error: "Tenant not found" });

    const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, keyId) });
    if (!key || key.tenantId !== id) {
      return reply.code(404).send({ error: "API key not found" });
    }
    if (key.revokedAt) {
      return reply.code(409).send({ error: "API key already revoked", revoked_at: key.revokedAt });
    }

    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId));

    return reply.code(200).send({ revoked: true, key_id: keyId });
  });
}
