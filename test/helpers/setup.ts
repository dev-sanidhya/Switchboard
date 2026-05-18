import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { buildServer } from "../../src/server.js";
import { db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import { generateId } from "../../src/observability/tracer.js";
import { hashKey } from "../../src/middleware/auth.js";
import { getMockAdapter } from "../../src/providers/registry.js";
import { clearInMemoryState } from "../../src/resilience/circuit-breaker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function setupTestDb() {
  const libsql = createClient({ url: "file:./test.db" });
  const testDb = drizzle(libsql);
  await migrate(testDb, {
    migrationsFolder: path.join(__dirname, "../../src/db/migrations"),
  });
  await libsql.close();
}

export async function clearDb() {
  await db.delete(schema.requests);
  await db.delete(schema.providerHealth);
  await db.delete(schema.apiKeys);
  await db.delete(schema.tenantLimits);
  await db.delete(schema.tenants);
  // Clear circuit breaker in-memory cache so stale state doesn't shadow empty DB
  clearInMemoryState();
}

export async function createTestTenant(opts: {
  name: string;
  requestsPerMinute?: number;
  budgetUsdMonthly?: number;
  allowedProviders?: string[];
  routingPolicy?: string;
}) {
  const tenantId = generateId();
  const limitId = generateId();
  const rawKey = `sk-test-${randomBytes(12).toString("hex")}`;
  const now = new Date();
  const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  await db.insert(schema.tenants).values({
    id: tenantId, name: opts.name, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.tenantLimits).values({
    id: limitId,
    tenantId,
    requestsPerMinute: opts.requestsPerMinute ?? 60,
    budgetUsdMonthly: opts.budgetUsdMonthly ?? 10,
    budgetUsedUsd: 0,
    budgetResetAt: nextReset,
    allowedProviders: opts.allowedProviders ? JSON.stringify(opts.allowedProviders) : null,
    allowedModels: null,
    routingPolicy: opts.routingPolicy ?? "cost",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.apiKeys).values({
    id: generateId(),
    tenantId,
    keyHash: hashKey(rawKey),
    label: "test",
    createdAt: now,
    revokedAt: null,
  });

  return { tenantId, limitId, apiKey: rawKey };
}

export function resetAllMocks() {
  for (const provider of ["groq", "cerebras", "gemini"]) {
    try {
      getMockAdapter(provider).setMode("reset");
    } catch {
      // provider might not have a mock
    }
  }
}

export async function startTestServer(port = 3999) {
  const server = await buildServer();
  await server.listen({ port, host: "127.0.0.1" });
  return server;
}

export function authHeader(key: string) {
  return { Authorization: `Bearer ${key}` };
}
