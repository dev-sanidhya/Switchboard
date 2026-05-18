import type { FastifyRequest, FastifyReply } from "fastify";

// Sliding window rate limiter using an in-process token bucket per tenant.
// NOTE: This is single-instance only. Multiple gateway instances would each
// enforce the limit independently, giving each tenant N*instances requests/min.
// Production fix: replace with Redis INCR + EXPIRE sliding window.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

function refill(bucket: Bucket, maxTokens: number) {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000 / 60; // minutes elapsed
  const refillAmount = elapsed * maxTokens;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + refillAmount);
  bucket.lastRefill = now;
}

export async function rateLimitMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const ctx = req.tenantCtx;
  if (!ctx) return;

  const { tenant, limits } = ctx;
  const maxPerMin = limits.requestsPerMinute;

  let bucket = buckets.get(tenant.id);
  if (!bucket) {
    bucket = { tokens: maxPerMin, lastRefill: Date.now() };
    buckets.set(tenant.id, bucket);
  }

  refill(bucket, maxPerMin);

  if (bucket.tokens < 1) {
    return reply.code(429).send({
      error: "Rate limit exceeded",
      limit: maxPerMin,
      window: "1m",
      retry_after_ms: Math.ceil((1 - bucket.tokens) * (60000 / maxPerMin)),
    });
  }

  bucket.tokens -= 1;
}
