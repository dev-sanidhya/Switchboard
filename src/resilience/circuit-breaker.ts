import { db } from "../db/client.js";
import { providerHealth } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { generateId } from "../observability/tracer.js";
import { logger } from "../observability/logger.js";

type CBState = "closed" | "open" | "half_open";

// In-process state mirrors the DB row. DB is authoritative on restart.
interface CBEntry {
  state: CBState;
  failureCount: number;
  lastFailureAt: Date | null;
  openedAt: Date | null;
}

const inMemory: Record<string, CBEntry> = {};

async function getOrCreate(provider: string): Promise<CBEntry> {
  if (inMemory[provider]) return inMemory[provider];

  let row = await db.query.providerHealth.findFirst({
    where: eq(providerHealth.provider, provider),
  });

  if (!row) {
    const now = new Date();
    await db.insert(providerHealth).values({
      id: generateId(),
      provider,
      state: "closed",
      failureCount: 0,
      lastFailureAt: null,
      openedAt: null,
      updatedAt: now,
    });
    row = await db.query.providerHealth.findFirst({
      where: eq(providerHealth.provider, provider),
    });
  }

  inMemory[provider] = {
    state: (row!.state as CBState) ?? "closed",
    failureCount: row!.failureCount ?? 0,
    lastFailureAt: row!.lastFailureAt ?? null,
    openedAt: row!.openedAt ?? null,
  };

  return inMemory[provider];
}

async function persist(provider: string, entry: CBEntry) {
  await db
    .update(providerHealth)
    .set({
      state: entry.state,
      failureCount: entry.failureCount,
      lastFailureAt: entry.lastFailureAt,
      openedAt: entry.openedAt,
      updatedAt: new Date(),
    })
    .where(eq(providerHealth.provider, provider));
}

export async function isOpen(provider: string): Promise<boolean> {
  const entry = await getOrCreate(provider);

  if (entry.state === "closed") return false;

  if (entry.state === "open") {
    const elapsed = Date.now() - (entry.openedAt?.getTime() ?? 0);
    if (elapsed >= config.CB_RESET_TIMEOUT_MS) {
      // Transition to half-open: allow one probe request
      entry.state = "half_open";
      await persist(provider, entry);
      logger.info({ provider, event: "circuit_half_open" }, "Circuit breaker -> half_open");
      return false; // allow this probe through
    }
    return true; // still open
  }

  // half_open: allow through (the result will close or re-open)
  return false;
}

export async function recordSuccess(provider: string) {
  const entry = await getOrCreate(provider);
  const wasHalfOpen = entry.state === "half_open";

  entry.state = "closed";
  entry.failureCount = 0;
  entry.lastFailureAt = null;
  entry.openedAt = null;
  await persist(provider, entry);

  if (wasHalfOpen) {
    logger.info({ provider, event: "circuit_closed" }, "Circuit breaker -> closed");
  }
}

export async function recordFailure(provider: string) {
  const entry = await getOrCreate(provider);
  entry.failureCount++;
  entry.lastFailureAt = new Date();

  if (entry.state === "half_open" || entry.failureCount >= config.CB_FAILURE_THRESHOLD) {
    entry.state = "open";
    entry.openedAt = new Date();
    await persist(provider, entry);
    logger.warn(
      { provider, failureCount: entry.failureCount, event: "circuit_open" },
      "Circuit breaker -> open"
    );
  } else {
    await persist(provider, entry);
  }
}

export async function getCircuitStates(): Promise<Record<string, CBState>> {
  const rows = await db.select().from(providerHealth);
  const result: Record<string, CBState> = {};
  for (const row of rows) {
    result[row.provider] = row.state as CBState;
  }
  return result;
}

export async function resetCircuit(provider: string) {
  // Clear in-memory first so getOrCreate re-reads from (clean) DB
  delete inMemory[provider];
  const entry = await getOrCreate(provider);
  entry.state = "closed";
  entry.failureCount = 0;
  entry.lastFailureAt = null;
  entry.openedAt = null;
  await persist(provider, entry);
  logger.info({ provider, event: "circuit_reset" }, "Circuit breaker manually reset");
}

// Used in tests after clearDb() to prevent stale in-memory state from being used
// against DB rows that no longer exist.
export function clearInMemoryState(provider?: string) {
  if (provider) {
    delete inMemory[provider];
  } else {
    for (const key of Object.keys(inMemory)) {
      delete inMemory[key];
    }
  }
}
