import { describe, it, expect, beforeEach } from "vitest";
import { CostRouter } from "../../src/routing/cost-router.js";
import { getMockAdapter } from "../../src/providers/registry.js";
import { resetCircuit } from "../../src/resilience/circuit-breaker.js";
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
    routingPolicy: "cost",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const router = new CostRouter();

beforeEach(async () => {
  await setupTestDb();
  await clearDb();
  getMockAdapter("groq").setMode("reset");
  getMockAdapter("cerebras").setMode("reset");
  await resetCircuit("groq");
  await resetCircuit("cerebras");
});

describe("cost router", () => {
  it("routes 'cheap' tier to cheapest available model (Groq llama-3.1-8b)", async () => {
    const result = await router.route(
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      makeLimits()
    );
    expect(result.provider).toBe("groq");
    expect(result.model).toBe("llama-3.1-8b-instant");
  });

  it("routes concrete model name directly without cost comparison", async () => {
    const result = await router.route(
      { model: "llama3.1-8b", messages: [{ role: "user", content: "hi" }] },
      makeLimits()
    );
    expect(result.provider).toBe("cerebras");
    expect(result.model).toBe("llama3.1-8b");
  });

  it("respects allowedProviders - skips providers not in list", async () => {
    const limits = makeLimits({
      allowedProviders: JSON.stringify(["cerebras"]),
    });
    const result = await router.route(
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      limits
    );
    expect(result.provider).toBe("cerebras");
  });

  it("skips provider with open circuit breaker", async () => {
    // Open Groq's circuit
    getMockAdapter("groq").setMode("error_500");
    const { recordFailure } = await import("../../src/resilience/circuit-breaker.js");
    await recordFailure("groq");
    await recordFailure("groq");
    await recordFailure("groq"); // threshold = 3

    const result = await router.route(
      { model: "cheap", messages: [{ role: "user", content: "hi" }] },
      makeLimits()
    );
    // Should fall over to Cerebras cheap tier
    expect(result.provider).toBe("cerebras");
  });

  it("throws when all circuits are open and no eligible provider", async () => {
    const { recordFailure } = await import("../../src/resilience/circuit-breaker.js");
    for (const p of ["groq", "cerebras"]) {
      await recordFailure(p);
      await recordFailure(p);
      await recordFailure(p);
    }

    const limits = makeLimits({
      allowedProviders: JSON.stringify(["groq", "cerebras"]),
    });
    await expect(
      router.route({ model: "cheap", messages: [{ role: "user", content: "hi" }] }, limits)
    ).rejects.toThrow("All eligible providers have open circuit breakers");
  });

  it("throws when allowedProviders is empty", async () => {
    const limits = makeLimits({ allowedProviders: JSON.stringify([]) });
    await expect(
      router.route({ model: "cheap", messages: [{ role: "user", content: "hi" }] }, limits)
    ).rejects.toThrow("No eligible models");
  });
});
