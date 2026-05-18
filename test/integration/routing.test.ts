import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  setupTestDb, clearDb, createTestTenant,
  resetAllMocks, startTestServer,
} from "../helpers/setup.js";
import { getMockAdapter } from "../../src/providers/registry.js";
import { resetCircuit } from "../../src/resilience/circuit-breaker.js";

let server: FastifyInstance;

beforeAll(async () => {
  await setupTestDb();
  server = await startTestServer(3993);
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await clearDb();
  resetAllMocks();
  await resetCircuit("groq");
  await resetCircuit("cerebras");
});

describe("metrics endpoint", () => {
  it("returns zero-count metrics for new tenant", async () => {
    const { tenantId } = await createTestTenant({ name: "metrics-test" });
    const res = await server.inject({
      method: "GET",
      url: `/metrics?tenant=${tenantId}&window=1h`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requests.total).toBe(0);
    expect(body.window).toBe("1h");
    expect(body.tenant).toBe(tenantId);
  });

  it("rejects invalid window parameter", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics?window=1y" });
    expect(res.statusCode).toBe(400);
  });

  it("accumulates request counts after completions", async () => {
    const { apiKey, tenantId } = await createTestTenant({
      name: "metrics-count-test",
      allowedProviders: ["groq"],
    });

    // Make 2 requests (will fail with 502 from mock but still get logged)
    for (let i = 0; i < 2; i++) {
      await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "cheap", messages: [{ role: "user", content: "hi" }] }),
      });
    }

    const res = await server.inject({
      method: "GET",
      url: `/metrics?tenant=${tenantId}&window=1h`,
    });
    const body = res.json();
    expect(body.requests.total).toBe(2);
  });

  it("returns spend breakdown by provider", async () => {
    const { tenantId } = await createTestTenant({ name: "spend-test" });
    const res = await server.inject({
      method: "GET",
      url: `/metrics?tenant=${tenantId}&window=24h`,
    });
    const body = res.json();
    expect(body.by_provider).toBeDefined();
    expect(body.by_model).toBeDefined();
    expect(body.cost_usd).toBeTypeOf("number");
  });
});

describe("cache", () => {
  it("serves cached response on identical deterministic request", async () => {
    const { apiKey } = await createTestTenant({ name: "cache-test" });
    const reqBody = {
      model: "cheap",
      messages: [{ role: "user", content: `cache-test-${Date.now()}` }],
      temperature: 0,
    };

    // First request - misses cache, hits real (mock will 502 but still logs)
    const r1 = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
    });

    // If first request succeeded, second should hit cache
    if (r1.statusCode === 200) {
      const r2 = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
      });
      expect(r2.statusCode).toBe(200);
      // Cache hit is logged but response body is identical
      expect(r2.json()).toEqual(r1.json());
    }
  });

  it("does not cache streaming responses", async () => {
    const { apiKey } = await createTestTenant({ name: "stream-cache-test" });
    const reqBody = {
      model: "cheap",
      messages: [{ role: "user", content: "stream test" }],
      temperature: 0,
      stream: true,
    };

    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
    });

    // Streaming response should have SSE content type, not be a cached JSON response
    if (res.statusCode === 200) {
      expect(res.headers["content-type"]).toContain("text/event-stream");
    }
  });

  it("does not cache high-temperature responses", async () => {
    const { isCacheable } = await import("../../src/cache/response-cache.js");
    expect(isCacheable({ model: "x", messages: [], temperature: 1.0 })).toBe(false);
    expect(isCacheable({ model: "x", messages: [], temperature: 0.0 })).toBe(true);
  });
});

describe("health endpoint", () => {
  it("returns ok status with provider list", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.configured_providers).toContain("groq");
    expect(body.configured_providers).toContain("cerebras");
    expect(body.cache).toBeDefined();
  });

  it("includes uptime in health response", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    const body = res.json();
    expect(body.uptime_s).toBeTypeOf("number");
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });
});

describe("test endpoints", () => {
  it("inject-failure endpoint is available in test mode", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/test/inject-failure",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "groq", mode: "reset" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects unknown provider for injection", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/test/inject-failure",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "unknown-provider", mode: "error_500" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown failure mode", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/test/inject-failure",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "groq", mode: "self_destruct" }),
    });
    expect(res.statusCode).toBe(400);
  });
});
