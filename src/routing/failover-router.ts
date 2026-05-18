import type { Router, RouteResult } from "./types.js";
import type { ChatRequest } from "../providers/types.js";
import type { TenantLimits } from "../db/schema.js";
import { MODEL_REGISTRY } from "../providers/types.js";
import { isOpen } from "../resilience/circuit-breaker.js";
import { listProviders } from "../providers/registry.js";

// Failover routing: try providers in priority order, but ALWAYS within the
// requested tier (or the exact requested model). Previous implementation
// always picked the provider's "best" tier model regardless of req.model,
// which silently upgraded "cheap" requests to "best" and broke cost control.
const PROVIDER_PRIORITY = ["groq", "cerebras", "gemini"];
const ABSTRACT_TIERS = new Set(["cheap", "balanced", "best"]);

export class FailoverRouter implements Router {
  async route(req: ChatRequest, limits: TenantLimits): Promise<RouteResult[]> {
    const allowedProviders = limits.allowedProviders
      ? (JSON.parse(limits.allowedProviders) as string[])
      : listProviders();

    const allowedModels = limits.allowedModels
      ? new Set(JSON.parse(limits.allowedModels) as string[])
      : null;

    let candidates = MODEL_REGISTRY.filter((spec) => {
      if (!allowedProviders.includes(spec.provider)) return false;
      if (allowedModels && !allowedModels.has(spec.modelId)) return false;
      return true;
    });

    if (candidates.length === 0) {
      throw new Error("No eligible models for this tenant configuration");
    }

    // Resolve target tier from the request. If req.model is an abstract
    // tier, use it directly. If it's a concrete model id, look up its tier
    // and prefer that exact model first, then same-tier fallbacks on other
    // providers. Unknown concrete models fall through to the full pool.
    let targetTier: string | null = null;
    let exactModelId: string | null = null;

    if (ABSTRACT_TIERS.has(req.model)) {
      targetTier = req.model;
    } else {
      const exact = candidates.find((s) => s.modelId === req.model);
      if (exact) {
        targetTier = exact.tier;
        exactModelId = exact.modelId;
      }
    }

    const pool = targetTier
      ? candidates.filter((s) => s.tier === targetTier)
      : candidates;

    if (pool.length === 0) {
      throw new Error(
        `No models match tier '${targetTier}' for this tenant`,
      );
    }

    // Order by: exact match first (if any), then provider priority.
    const priorityRank = (provider: string) => {
      const idx = PROVIDER_PRIORITY.indexOf(provider);
      return idx === -1 ? 999 : idx;
    };

    pool.sort((a, b) => {
      if (exactModelId) {
        if (a.modelId === exactModelId) return -1;
        if (b.modelId === exactModelId) return 1;
      }
      return priorityRank(a.provider) - priorityRank(b.provider);
    });

    // One candidate per provider (the matching-tier model), filtered by open circuits.
    const results: RouteResult[] = [];
    const seenProviders = new Set<string>();

    for (const spec of pool) {
      if (seenProviders.has(spec.provider)) continue;

      const circuitOpen = await isOpen(spec.provider);
      if (circuitOpen) continue;

      results.push({ provider: spec.provider, model: spec.modelId });
      seenProviders.add(spec.provider);
    }

    if (results.length === 0) {
      throw new Error("All providers are unavailable (circuits open or not allowed)");
    }
    return results;
  }
}
