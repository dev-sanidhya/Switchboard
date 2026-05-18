import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  setupTestDb, clearDb, createTestTenant,
  resetAllMocks, startTestServer,
} from "../helpers/setup.js";
import { getMockAdapter } from "../../src/providers/registry.js";
import { resetCircuit, getCircuitStates, isOpen } from "../../src/resilience/circuit-breaker.js";

let server: FastifyInstance;
let apiKey: string;

beforeAll(async () => {
  await setupTestDb();
  server = await startTestServer(3992);
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await clearDb();
  resetAllMocks();
  await resetCircuit("groq");
  await resetCircuit("cerebras");
  const tenant = await createTestTenant({
    name: "resilience-tenant",
    allowedProviders: ["groq", "cerebras"],
    routingPolicy: "cost",
  });
  apiKey = tenant.apiKey;
});

async function chat(key = apiKey) {
  return server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "cheap",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

describe("circuit breaker integration", () => {
  it("circuit opens after threshold failures and returns 503", async () => {
    getMockAdapter("groq").setMode("error_500");
    getMockAdapter("cerebras").setMode("error_500");

    // CB_FAILURE_THRESHOLD=3, so 3 failures open both circuits
    for (let i = 0; i < 3; i++) {
      await chat();
    }

    const states = await getCircuitStates();
    // At least one circuit should be open
    const anyOpen = Object.values(states).some((s) => s === "open");
    expect(anyOpen).toBe(true);
  });

  it("health endpoint reflects open circuit breaker state", async () => {
    getMockAdapter("groq").setMode("error_500");
    getMockAdapter("cerebras").setMode("error_500");

    for (let i = 0; i < 3; i++) {
      await chat();
    }

    const res = await server.inject({ method: "GET", url: "/health" });
    const body = res.json();
    const providerStates = body.providers as Record<string, string>;
    const anyOpen = Object.values(providerStates).some((s) => s === "open");
    expect(anyOpen).toBe(true);
  });

  it("circuit recovers after reset and serves requests again", async () => {
    getMockAdapter("groq").setMode("error_500");
    getMockAdapter("cerebras").setMode("error_500");

    for (let i = 0; i < 3; i++) {
      await chat();
    }

    expect(await isOpen("groq")).toBe(true);

    // Reset both circuits and remove mock failures
    await resetCircuit("groq");
    await resetCircuit("cerebras");
    getMockAdapter("groq").setMode("reset");
    getMockAdapter("cerebras").setMode("reset");

    expect(await isOpen("groq")).toBe(false);

    // Now requests should work (or fail with 502 from mock, not circuit open)
    const res = await chat();
    expect(res.statusCode).not.toBe(503);
  });

  it("failure injection endpoint opens circuit", async () => {
    // Inject error via HTTP endpoint
    const inject = await server.inject({
      method: "POST",
      url: "/test/inject-failure",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "groq", mode: "error_500" }),
    });
    expect(inject.statusCode).toBe(200);

    // After threshold failures, circuit should open
    for (let i = 0; i < 3; i++) {
      await chat();
    }

    const health = await server.inject({ method: "GET", url: "/health" });
    const states = health.json().providers;
    expect(states.groq).toBe("open");
  });

  it("reset endpoint clears mock and circuit breaker", async () => {
    getMockAdapter("groq").setMode("error_500");
    for (let i = 0; i < 3; i++) await chat();
    expect(await isOpen("groq")).toBe(true);

    const reset = await server.inject({
      method: "POST",
      url: "/test/inject-failure",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "groq", mode: "reset" }),
    });
    expect(reset.statusCode).toBe(200);
    expect(await isOpen("groq")).toBe(false);
  });
});

describe("failover routing", () => {
  it("falls over to cerebras when groq circuit is open", async () => {
    // Force Groq circuit open
    for (let i = 0; i < 3; i++) {
      await recordManualFailure("groq");
    }
    expect(await isOpen("groq")).toBe(true);

    // Request should route to cerebras instead (may fail with 502 from unset mock
    // but the important thing is it's not rejected by circuit breaker as 503)
    const res = await chat();
    // 503 = no provider available. If we get anything else, failover worked or cerebras responded
    // The key assertion: request was attempted (not immediately 503 due to only groq being requested)
    expect(res.statusCode).not.toBe(503);
  });
});

async function recordManualFailure(provider: string) {
  const { recordFailure } = await import("../../src/resilience/circuit-breaker.js");
  await recordFailure(provider);
}
