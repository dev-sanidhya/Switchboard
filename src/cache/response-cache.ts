import { LRUCache } from "lru-cache";
import { createHash } from "crypto";
import { config } from "../config/index.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";

const cache = new LRUCache<string, ChatResponse>({
  max: config.CACHE_MAX_ITEMS,
  ttl: config.CACHE_TTL_SECONDS * 1000,
});

// Only cache deterministic or near-deterministic requests.
// High temperature = non-deterministic = not worth caching.
const CACHE_TEMP_THRESHOLD = 0.3;

export function isCacheable(req: ChatRequest): boolean {
  if (req.stream) return false;
  const temp = req.temperature ?? 0.7;
  return temp <= CACHE_TEMP_THRESHOLD;
}

export function cacheKey(req: ChatRequest): string {
  const payload = JSON.stringify({
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.max_tokens,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function getCached(key: string): ChatResponse | undefined {
  return cache.get(key);
}

export function setCached(key: string, response: ChatResponse): void {
  cache.set(key, response);
}

export function getCacheStats() {
  return {
    size: cache.size,
    max: config.CACHE_MAX_ITEMS,
    ttl_seconds: config.CACHE_TTL_SECONDS,
  };
}
