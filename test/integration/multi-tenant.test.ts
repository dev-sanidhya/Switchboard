import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { setupTestDb, clearDb, createTestTenant, resetAllMocks, startTestServer } from "../helpers/setup.js";
import { getMockAdapter } from "../../src/providers/registry.js";
import { resetCircuit } from "../../src/resilience/circuit-breaker.js";
import { db } from "../../src/db/client.js";
import { tenantLimits } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

let server: FastifyInstance;

beforeAll(async () => {
  await setupTestDb();
  server = await startTestServer(3991);
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await clearDb();
  resetAllMocks();
  await resetCircuit("groq");
  await resetCircuit("cerebras");
  // Set mock to return success so no real API calls
  getMockAdapter("groq").setMode("reset");
  getMockAdapter("cerebras").setMode("reset");
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await server.inject({
    method: "POST",
    url: path,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() };
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await server.inject({ method: "GET", url: path, headers });
  return { status: res.statusCode, body: res.json() };
}

describe("auth", () => {
  it("rejects requests with no Authorization header", async () => {
    const { status } = await post("/v1/chat/completions", {
      model: "cheap", messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(401);
  });

  it("rejects requests with invalid API key", async () => {
    const { status } = await post(
      "/v1/chat/completions",
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      { Authorization: "Bearer sk-totally-fake-key" }
    );
    expect(status).toBe(401);
  });

  it("accepts valid API key", async () => {
    const { apiKey } = await createTestTenant({ name: "auth-test" });
    // Mock so we don't hit real APIs
    getMockAdapter("groq").setMode("reset"); // default mock returns success
    const { status } = await post(
      "/v1/chat/completions",
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      { Authorization: `Bearer ${apiKey}` }
    );
    // 200 or 502 depending on whether mock is active; key was valid so not 401
    expect(status).not.toBe(401);
  });
});

describe("rate limiting", () => {
  it("returns 429 when tenant exceeds requests per minute", async () => {
    const { apiKey } = await createTestTenant({
      name: "rate-limit-test",
      requestsPerMinute: 2,
    });

    const makeReq = () =>
      post(
        "/v1/chat/completions",
        { model: "cheap", messages: [{ role: "user", content: "hi" }] },
        { Authorization: `Bearer ${apiKey}` }
      );

    // First two should pass (or fail with 502 from mock - not 429)
    const r1 = await makeReq();
    const r2 = await makeReq();
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);

    // Third should be rate limited
    const r3 = await makeReq();
    expect(r3.status).toBe(429);
  });

  it("rate limit is isolated per tenant", async () => {
    const { apiKey: key1 } = await createTestTenant({ name: "tenant-rla", requestsPerMinute: 1 });
    const { apiKey: key2 } = await createTestTenant({ name: "tenant-rlb", requestsPerMinute: 60 });

    // Exhaust tenant 1
    await post("/v1/chat/completions", { model: "cheap", messages: [{ role: "user", content: "hi" }] }, { Authorization: `Bearer ${key1}` });
    const limited = await post("/v1/chat/completions", { model: "cheap", messages: [{ role: "user", content: "hi" }] }, { Authorization: `Bearer ${key1}` });
    expect(limited.status).toBe(429);

    // Tenant 2 should still work
    const fine = await post("/v1/chat/completions", { model: "cheap", messages: [{ role: "user", content: "hi" }] }, { Authorization: `Bearer ${key2}` });
    expect(fine.status).not.toBe(429);
  });
});

describe("budget enforcement", () => {
  it("returns 402 when tenant budget is exhausted", async () => {
    const { apiKey, limitId } = await createTestTenant({
      name: "budget-test",
      budgetUsdMonthly: 0.001, // very tight budget
    });

    // Manually set budget as fully used
    await db.update(tenantLimits)
      .set({ budgetUsedUsd: 0.001 })
      .where(eq(tenantLimits.id, limitId));

    const { status, body } = await post(
      "/v1/chat/completions",
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      { Authorization: `Bearer ${apiKey}` }
    );
    expect(status).toBe(402);
    expect(body.error).toMatch(/budget/i);
  });

  it("budget exhaustion on one tenant does not affect another", async () => {
    const { apiKey: exhaustedKey, limitId } = await createTestTenant({
      name: "budget-exhausted",
      budgetUsdMonthly: 0.001,
    });
    const { apiKey: healthyKey } = await createTestTenant({
      name: "budget-healthy",
      budgetUsdMonthly: 10,
    });

    // Exhaust first tenant
    await db.update(tenantLimits)
      .set({ budgetUsedUsd: 0.001 })
      .where(eq(tenantLimits.id, limitId));

    const { status: s1 } = await post(
      "/v1/chat/completions",
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      { Authorization: `Bearer ${exhaustedKey}` }
    );
    expect(s1).toBe(402);

    // Second tenant should not be 402 (may be 502 from mock, but not budget error)
    const { status: s2 } = await post(
      "/v1/chat/completions",
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      { Authorization: `Bearer ${healthyKey}` }
    );
    expect(s2).not.toBe(402);
  });
});

describe("provider allowlists", () => {
  it("returns 503 when tenant's allowed provider has no models", async () => {
    const { apiKey } = await createTestTenant({
      name: "restricted-provider",
      allowedProviders: ["nonexistent-provider"],
    });

    const { status } = await post(
      "/v1/chat/completions",
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      { Authorization: `Bearer ${apiKey}` }
    );
    expect(status).toBe(503);
  });
});

describe("input validation", () => {
  it("rejects invalid request body", async () => {
    const { apiKey } = await createTestTenant({ name: "validation-test" });
    const { status } = await post(
      "/v1/chat/completions",
      { model: 123, messages: "not-an-array" },
      { Authorization: `Bearer ${apiKey}` }
    );
    expect(status).toBe(400);
  });

  it("response includes trace_id on error", async () => {
    const { apiKey } = await createTestTenant({ name: "trace-test" });
    const { body } = await post(
      "/v1/chat/completions",
      { model: 123, messages: "bad" },
      { Authorization: `Bearer ${apiKey}` }
    );
    expect(body.trace_id).toBeDefined();
    expect(typeof body.trace_id).toBe("string");
  });
});

describe("admin endpoints", () => {
  it("creates a tenant and returns an API key", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/admin/tenants",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "admin-created", budget_usd_monthly: 5 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tenant_id).toBeDefined();
    expect(body.api_key).toMatch(/^sk-/);
  });

  it("lists tenants", async () => {
    await createTestTenant({ name: "list-me" });
    const res = await server.inject({ method: "GET", url: "/admin/tenants" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("admin X-Admin-Key authentication", () => {
  const TEST_ADMIN_KEY = "test-admin-key-switchboard";

  beforeEach(() => {
    // Activate admin auth for this describe block.
    // The preHandler reads process.env at request time, so this takes effect
    // immediately without rebuilding the server.
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  });

  afterEach(() => {
    // Remove so that other test blocks remain unaffected (open admin).
    delete process.env.ADMIN_API_KEY;
  });

  it("rejects GET /admin/tenants with no X-Admin-Key header", async () => {
    const res = await server.inject({ method: "GET", url: "/admin/tenants" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/X-Admin-Key/i);
  });

  it("rejects GET /admin/tenants with wrong X-Admin-Key value", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/admin/tenants",
      headers: { "x-admin-key": "totally-wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("allows GET /admin/tenants with correct X-Admin-Key", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/admin/tenants",
      headers: { "x-admin-key": TEST_ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("rejects POST /admin/tenants without the key", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/admin/tenants",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should-not-be-created" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("allows POST /admin/tenants with correct key and creates tenant", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/admin/tenants",
      headers: { "Content-Type": "application/json", "x-admin-key": TEST_ADMIN_KEY },
      body: JSON.stringify({ name: "authed-tenant", budget_usd_monthly: 5 }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().api_key).toMatch(/^sk-/);
  });
});
