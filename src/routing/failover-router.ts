import type { Router, RouteResult } from "./types.js";
import type { ChatRequest } from "../providers/types.js";
import type { TenantLimits } from "../db/schema.js";
import { MODEL_REGISTRY } from "../providers/types.js";
import { isOpen } from "../resilience/circuit-breaker.js";
import { listProviders } from "../providers/registry.js";

// Failover router: tries providers in order of preference, skips those with open circuits.
// Priority: groq first, then gemini.
const PROVIDER_PRIORITY = ["groq", "gemini"];

export class FailoverRouter implements Router {
  async route(req: ChatRequest, limits: TenantLimits): Promise<RouteResult> {
    const allowedProviders = limits.allowedProviders
      ? (JSON.parse(limits.allowedProviders) as string[])
      : listProviders();

    const ordered = PROVIDER_PRIORITY.filter((p) => allowedProviders.includes(p));

    for (const provider of ordered) {
      const circuitOpen = await isOpen(provider);
      if (circuitOpen) continue;

      // Pick the most capable model this provider offers from the registry
      const spec = MODEL_REGISTRY.filter((s) => s.provider === provider).sort((a, b) => {
        const tierRank = { cheap: 0, balanced: 1, best: 2 };
        return tierRank[b.tier] - tierRank[a.tier];
      })[0];

      if (spec) return { provider, model: spec.modelId };
    }

    throw new Error("All providers are unavailable (circuits open or not allowed)");
  }
}
