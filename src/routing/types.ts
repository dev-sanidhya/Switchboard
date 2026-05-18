import type { ChatRequest } from "../providers/types.js";
import type { TenantLimits } from "../db/schema.js";

export interface RouteResult {
  provider: string;
  model: string;
}

export interface Router {
  /**
   * Returns the ordered list of routing candidates to try. The handler walks
   * the list in order: if the first provider fails with 5xx/network/timeout,
   * the next candidate is tried within the same request. This is true same-
   * request failover, not just circuit-breaker-driven failover after threshold.
   *
   * CostRouter returns cheapest-first; FailoverRouter returns priority-first.
   * Candidates with open circuits are pre-filtered.
   */
  route(req: ChatRequest, limits: TenantLimits): Promise<RouteResult[]>;
}
