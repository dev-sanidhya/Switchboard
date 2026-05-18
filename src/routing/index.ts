import { CostRouter } from "./cost-router.js";
import { FailoverRouter } from "./failover-router.js";
import type { Router } from "./types.js";

const cost = new CostRouter();
const failover = new FailoverRouter();

export function getRouter(policy: string): Router {
  switch (policy) {
    case "failover":
      return failover;
    case "cost":
    default:
      return cost;
  }
}

export type { Router, RouteResult } from "./types.js";
