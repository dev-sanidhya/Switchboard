import type { ChatRequest } from "../providers/types.js";
import type { TenantLimits } from "../db/schema.js";

export interface RouteResult {
  provider: string;
  model: string;
}

export interface Router {
  route(req: ChatRequest, limits: TenantLimits): Promise<RouteResult>;
}
