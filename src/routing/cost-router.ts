import type { Router, RouteResult } from "./types.js";
import type { ChatRequest } from "../providers/types.js";
import type { TenantLimits } from "../db/schema.js";
import { MODEL_REGISTRY, estimateCost } from "../providers/types.js";
import { isOpen } from "../resilience/circuit-breaker.js";
import { listProviders } from "../providers/registry.js";

const ABSTRACT_TIERS = new Set(["cheap", "balanced", "best"]);

export class CostRouter implements Router {
  async route(req: ChatRequest, limits: TenantLimits): Promise<RouteResult[]> {
    const allowedProviders = limits.allowedProviders
      ? (JSON.parse(limits.allowedProviders) as string[])
      : listProviders();

    const allowedModels = limits.allowedModels
      ? new Set(JSON.parse(limits.allowedModels) as string[])
      : null;

    // Estimate input token count from messages (rough: 1 token ~= 4 chars)
    const inputTokenEstimate = Math.ceil(
      req.messages.reduce((sum, m) => sum + m.content.length, 0) / 4
    );
    const outputTokenEstimate = req.max_tokens ?? 512;

    let candidates = MODEL_REGISTRY.filter((spec) => {
      if (!allowedProviders.includes(spec.provider)) return false;
      if (allowedModels && !allowedModels.has(spec.modelId)) return false;
      return true;
    });

    if (candidates.length === 0) {
      throw new Error("No eligible models for this tenant configuration");
    }

    // If client sent an abstract tier, filter to that tier
    if (ABSTRACT_TIERS.has(req.model)) {
      const tierCandidates = candidates.filter((s) => s.tier === req.model);
      if (tierCandidates.length > 0) candidates = tierCandidates;
    } else {
      // Client sent a concrete model name - find its spec and prefer it,
      // but still build a fallback list of equivalent-tier models on other providers.
      const exact = candidates.find((s) => s.modelId === req.model);
      if (exact) {
        const sameTier = candidates.filter(
          (c) => c.tier === exact.tier && c.modelId !== exact.modelId,
        );
        const ordered: RouteResult[] = [
          { provider: exact.provider, model: exact.modelId },
          ...sameTier.map((c) => ({ provider: c.provider, model: c.modelId })),
        ];
        return await filterHealthy(ordered);
      }
      // Model not in registry or not allowed - fall through to cheapest available
    }

    // Sort by estimated cost ascending, drop any whose circuit breaker is open.
    const withCost = await Promise.all(
      candidates.map(async (spec) => ({
        spec,
        cost: estimateCost(spec, inputTokenEstimate, outputTokenEstimate),
        circuitOpen: await isOpen(spec.provider),
      }))
    );

    const healthy = withCost.filter((c) => !c.circuitOpen);

    if (healthy.length === 0) {
      throw new Error("All eligible providers have open circuit breakers");
    }

    healthy.sort((a, b) => a.cost - b.cost);
    return healthy.map((h) => ({ provider: h.spec.provider, model: h.spec.modelId }));
  }
}

async function filterHealthy(candidates: RouteResult[]): Promise<RouteResult[]> {
  const checks = await Promise.all(candidates.map((c) => isOpen(c.provider)));
  const result = candidates.filter((_, i) => !checks[i]);
  if (result.length === 0) {
    throw new Error("All eligible providers have open circuit breakers");
  }
  return result;
}
