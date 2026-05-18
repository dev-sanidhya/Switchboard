import { describe, it, expect, beforeEach } from "vitest";
import {
  isOpen,
  recordSuccess,
  recordFailure,
  resetCircuit,
  getCircuitStates,
  clearInMemoryState,
} from "../../src/resilience/circuit-breaker.js";
import { setupTestDb, clearDb } from "../helpers/setup.js";

const PROVIDER = "test-provider-cb";

beforeEach(async () => {
  await setupTestDb();
  await clearDb(); // also calls clearInMemoryState()
  clearInMemoryState(PROVIDER);
});

describe("circuit breaker", () => {
  it("starts closed", async () => {
    expect(await isOpen(PROVIDER)).toBe(false);
  });

  it("opens after hitting failure threshold", async () => {
    // CB_FAILURE_THRESHOLD=3 in test env
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    expect(await isOpen(PROVIDER)).toBe(false); // still closed at 2

    await recordFailure(PROVIDER);
    expect(await isOpen(PROVIDER)).toBe(true); // open at 3
  });

  it("closes after a success", async () => {
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    expect(await isOpen(PROVIDER)).toBe(true);

    await recordSuccess(PROVIDER);
    expect(await isOpen(PROVIDER)).toBe(false);
  });

  it("transitions to half_open after reset timeout", async () => {
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    expect(await isOpen(PROVIDER)).toBe(true);

    // CB_RESET_TIMEOUT_MS=500ms in test env - wait for it
    await new Promise((r) => setTimeout(r, 600));

    // Should now allow probe through (half_open returns false)
    expect(await isOpen(PROVIDER)).toBe(false);

    const states = await getCircuitStates();
    expect(states[PROVIDER]).toBe("half_open");
  });

  it("re-opens from half_open on failure", async () => {
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    await new Promise((r) => setTimeout(r, 600));
    await isOpen(PROVIDER); // triggers half_open transition

    await recordFailure(PROVIDER); // probe fails
    expect(await isOpen(PROVIDER)).toBe(true);
  });

  it("closes from half_open on success", async () => {
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    await new Promise((r) => setTimeout(r, 600));
    await isOpen(PROVIDER); // triggers half_open transition

    await recordSuccess(PROVIDER); // probe succeeds
    const states = await getCircuitStates();
    expect(states[PROVIDER]).toBe("closed");
  });

  it("manual reset clears the circuit", async () => {
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    await recordFailure(PROVIDER);
    expect(await isOpen(PROVIDER)).toBe(true);

    await resetCircuit(PROVIDER);
    expect(await isOpen(PROVIDER)).toBe(false);
  });
});
