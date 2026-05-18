import { describe, it, expect, beforeEach } from "vitest";
import { FailoverRouter } from "../../src/routing/failover-router.js";
import { getMockAdapter } from "../../src/providers/registry.js";
import { resetCircuit, recordFailure } from "../../src/resilience/circuit-breaker.js";
import { setupTestDb, clearDb } from "../helpers/setup.js";
import type { TenantLimits } from "../../src/db/schema.js";

function makeLimits(overrides: Partial<TenantLimits> = {}): TenantLimits {
  return {
    id: "limit-1",
    tenantId: "tenant-1",
    requestsPerMinute: 60,
    budgetUsdMonthly: 10,
    budgetUsedUsd: 0,
    budgetResetAt: new Date(Date.now() + 86400000),
    allowedProviders: null,
    allowedModels: null,
    routingPolicy: "failover",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const router = new FailoverRouter();

beforeEach(async () => {
  await setupTestDb();
  await clearDb();
  getMockAdapter("groq").setMode("reset");
  getMockAdapter("cerebras").setMode("reset");
  await resetCircuit("groq");
  await resetCircuit("cerebras");
});

describe("failover router - respects requested tier (codex regression)", () => {
  it("'cheap' request returns cheap-tier models, not best", async () => {
    // Codex repro: previously this returned llama-3.3-70b-versatile (best tier)
    // because the router always upgraded to the provider's most capable model.
    const candidates = await router.route(
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      makeLimits(),
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].provider).toBe("groq");
    expect(candidates[0].model).toBe("llama-3.1-8b-instant"); // groq's cheap model

    // Cerebras fallback (also cheap tier)
    expect(candidates[1]?.provider).toBe("cerebras");
    expect(candidates[1]?.model).toBe("llama3.1-8b");

    // None of the candidates should be a "best" tier model
    expect(candidates.find((c) => c.model === "llama-3.3-70b-versatile")).toBeUndefined();
    expect(candidates.find((c) => c.model === "gpt-oss-120b")).toBeUndefined();
  });

  it("'best' request returns best-tier models", async () => {
    const candidates = await router.route(
      { model: "best", messages: [{ role: "user", content: "hi" }] },
      makeLimits(),
    );
    expect(candidates[0].provider).toBe("groq");
    expect(candidates[0].model).toBe("llama-3.3-70b-versatile");
  });

  it("'balanced' request only returns balanced-tier models (groq only has one)", async () => {
    const candidates = await router.route(
      { model: "balanced", messages: [{ role: "user", content: "hi" }] },
      makeLimits(),
    );
    expect(candidates[0].provider).toBe("groq");
    expect(candidates[0].model).toBe("meta-llama/llama-4-scout-17b-16e-instruct");
    // No cerebras balanced model exists; failover list is just groq
    expect(candidates.length).toBe(1);
  });

  it("concrete model name returns exact model first, then same-tier on other providers", async () => {
    const candidates = await router.route(
      { model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "hi" }] },
      makeLimits(),
    );
    expect(candidates[0]).toEqual({ provider: "groq", model: "llama-3.1-8b-instant" });
    // Cerebras has a cheap-tier alternative
    expect(candidates[1]?.provider).toBe("cerebras");
  });

  it("skips providers with open circuit breakers", async () => {
    // Open groq's circuit
    for (let i = 0; i < 3; i++) await recordFailure("groq"); // CB_FAILURE_THRESHOLD=3 in tests

    const candidates = await router.route(
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      makeLimits(),
    );
    // groq dropped; cerebras is the first candidate
    expect(candidates[0].provider).toBe("cerebras");
  });

  it("respects allowedProviders", async () => {
    const candidates = await router.route(
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      makeLimits({ allowedProviders: JSON.stringify(["cerebras"]) }),
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0].provider).toBe("cerebras");
  });

  it("throws when no eligible providers", async () => {
    await expect(
      router.route(
        { model: "cheap", messages: [{ role: "user", content: "hi" }] },
        makeLimits({ allowedProviders: JSON.stringify([]) }),
      ),
    ).rejects.toThrow("No eligible models");
  });
});
