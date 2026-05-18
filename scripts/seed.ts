import "dotenv/config";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "../src/db/schema.js";
import { generateId } from "../src/observability/tracer.js";
import { hashKey } from "../src/middleware/auth.js";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.DATABASE_URL ?? "./switchboard.db";

const libsql = createClient({ url: `file:${DB_URL}` });
const db = drizzle(libsql, { schema });

await migrate(db, { migrationsFolder: path.join(__dirname, "../src/db/migrations") });

const now = new Date();
const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);

function makeKey() {
  return `sk-${randomBytes(24).toString("hex")}`;
}

const tenantDefs = [
  {
    name: "tenant-alpha",
    requestsPerMinute: 60,
    budgetUsdMonthly: 5.0,
    allowedProviders: null,
    allowedModels: null,
    routingPolicy: "cost",
    keyLabel: "alpha-default",
  },
  {
    name: "tenant-beta",
    requestsPerMinute: 10,
    budgetUsdMonthly: 0.10,
    allowedProviders: JSON.stringify(["groq"]),
    allowedModels: null,
    routingPolicy: "failover",
    keyLabel: "beta-default",
  },
  {
    name: "tenant-gamma",
    requestsPerMinute: 5,
    budgetUsdMonthly: 5.0,
    allowedProviders: JSON.stringify(["groq", "gemini"]),
    allowedModels: null,
    routingPolicy: "cost",
    keyLabel: "gamma-default",
  },
];

console.log("\n=== Switchboard Demo Seed ===\n");

for (const def of tenantDefs) {
  const tenantId = generateId();
  const limitId = generateId();
  const keyId = generateId();
  const rawKey = makeKey();

  await db.insert(schema.tenants).values({
    id: tenantId, name: def.name, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.tenantLimits).values({
    id: limitId, tenantId,
    requestsPerMinute: def.requestsPerMinute,
    budgetUsdMonthly: def.budgetUsdMonthly,
    budgetUsedUsd: 0,
    budgetResetAt: nextReset,
    allowedProviders: def.allowedProviders,
    allowedModels: def.allowedModels,
    routingPolicy: def.routingPolicy,
    createdAt: now, updatedAt: now,
  });
  await db.insert(schema.apiKeys).values({
    id: keyId, tenantId, keyHash: hashKey(rawKey), label: def.keyLabel,
    createdAt: now, revokedAt: null,
  });

  console.log(`Tenant: ${def.name}`);
  console.log(`  API Key:        ${rawKey}`);
  console.log(`  Rate limit:     ${def.requestsPerMinute} req/min`);
  console.log(`  Budget:         $${def.budgetUsdMonthly}/month`);
  console.log(`  Providers:      ${def.allowedProviders ?? "all"}`);
  console.log(`  Routing:        ${def.routingPolicy}`);
  console.log();
}

console.log("Seed complete. Use keys above with: Authorization: Bearer <key>\n");
await libsql.close();
