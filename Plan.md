# Switchboard - Multi-Tenant LLM Gateway
## Skyclad Ventures Senior Backend Engineer Assignment

**Deadline:** Day 7 from receipt (7 days)
**Repo:** https://github.com/dev-sanidhya/Switchboard
**Stack:** TypeScript + Fastify + SQLite (Drizzle ORM) + pino
**Providers:** Groq (primary) + Cerebras (secondary) - both free tier, OpenAI-compatible APIs

---

## Project Overview

Build a production-grade multi-tenant LLM gateway that sits between application code and multiple LLM providers (Anthropic + OpenAI minimum). The gateway provides unified API surface, multi-tenancy, intelligent routing, resilience, observability, caching, streaming, and persistence.

---

## Standout Factors - What Gets Us Hired

These are the specific things the evaluators called out (explicitly or implicitly) that most candidates will miss. Every one of these must ship.

### 1. Failure Injection Endpoint (MUST SHIP)
The assignment literally says "please make this easy." Build `POST /test/inject-failure` with modes:
- `error_500` - provider returns HTTP 500
- `timeout` - request hangs until gateway timeout fires
- `slow_response` - adds 3s artificial delay (triggers latency routing)
- `rate_limited` - provider returns 429
- `reset` - restores real adapter

Only enabled when `ENABLE_TEST_ENDPOINTS=true`. The evaluator hits one curl command and watches circuit breakers trip, retries fire, failover kick in. That's the "yes" moment.

### 2. Health Endpoint with Circuit Breaker State (MUST SHIP)
`GET /health` returns live circuit breaker state per provider:
```json
{"providers": {"groq": "closed", "cerebras": "open"}, "db": "ok", "uptime_s": 3820}
```
Evaluator injects a failure, refreshes /health, sees `"open"`. Clears it, sees `"closed"`. Narrative is self-evident.

### 3. Streaming Partial-Response Handling (MUST SHIP)
If upstream drops mid-stream (connection abort after token 50 of 200), we:
- Flush whatever tokens already arrived to the client
- Emit a structured log event: `{"event": "upstream_abort", "tokens_flushed": 50, ...}`
- End the SSE stream cleanly with a final `data: [PARTIAL]\n\n` marker
Do NOT surface a 500. The client gets partial data + a clean signal. Almost no candidates do this.

### 4. Metrics Endpoint That Answers Their Exact Question (MUST SHIP)
Assignment says: "answer 'what did tenant X spend yesterday on which model' in under a minute."
`GET /metrics?tenant=X&window=24h` returns spend-by-model breakdown. If they have to grep logs, we failed.

### 5. Seed Script (MUST SHIP)
`npm run seed` - creates 3 demo tenants with different limits in 3 seconds:
- `tenant-a`: high budget, Groq only, cost-routing policy
- `tenant-b`: tight budget ($0.10), both providers, failover policy
- `tenant-c`: strict rate limit (5 req/min), to demo 429 isolation
Outputs API keys to console. Evaluator is testing multi-tenancy in 60 seconds.

### 6. DESIGN.md Written Like a Post-Mortem Author (MUST SHIP)
Reference LiteLLM, Portkey, Helicone - explain their tradeoffs and what we'd do differently.
Failure modes section must be brutal and specific:
- "Two instances = 2x rate limit per tenant because rate limiting is in-process, not Redis"
- "Large prompt (200KB) is not rejected at gateway boundary - this is a bug in v1"
- "Cache race condition: two identical concurrent requests both hit the provider. First writer wins. No thundering herd protection. At high concurrency this is real."
- "Groq's free tier has global rate limits. If two tenants both use Groq and both hit rate limits, a 429 from Groq looks like a provider error, not a tenant error. The attribution is wrong."

### 7. The "What We Didn't Build" Section Being Brutally Specific
Every v2 item should have: what it is, why we punted, and what breaks without it.
Not "we'd add Redis" - instead: "Single-instance rate limiting means horizontal scaling is broken. The fix is a Redis INCR + EXPIRE sliding window. Punted to avoid a mandatory Redis dependency for local setup. Breaks when running > 1 gateway instance."

### 8. Routing Engine with Real Cost Math
Not round-robin. Actual calculation:
```
cost = input_tokens * provider.input_price_per_1k / 1000
     + estimated_output_tokens * provider.output_price_per_1k / 1000
```
Route to cheapest healthy provider. On tie, use p95 latency from provider_health table.
This is the feature that proves we understand the space.

### 9. Scope Discipline - What We're Cutting
These are explicitly NOT being built, documented as such:
- Admin UI (no frontend, per rules)
- Redis (documented path, not a dependency)
- JWT/OAuth (API key auth is correct scope)
- Multi-region / deployment story (documented as production gap)
- PII redaction / prompt injection detection (v2)
- Webhook delivery for async completions (v2)
- Fine-grained RBAC within tenant (v2)

### 10. Commit Discipline
Every meaningful unit of work = one commit. No batching. Commit messages ~5 words.
Examples: "add circuit breaker state machine", "wire groq streaming adapter", "add tenant budget enforcement"

---

## Architecture Decision

### Stack Choices

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js + TypeScript | Async I/O, SSE streaming, evaluators read TS |
| Framework | Fastify | 40% faster than Express, built-in schema validation, excellent plugin system, TypeScript-native |
| ORM | Drizzle | Type-safe, zero runtime overhead, easy migrations, SQLite/Postgres swap is trivial |
| Database | SQLite (dev) | Assignment explicitly allows SQLite; design doc covers Postgres migration |
| Logging | pino | Structured JSON, fastest Node logger, great for log parsing |
| Cache | In-memory LRU + TTL | No Redis dependency for local setup; document Redis path for production |
| Provider 1 | Groq | Free tier, OpenAI-compatible API, ultra-fast inference on Llama 3.3 70B + Llama 3.1 8B + Mixtral |
| Provider 2 | Cerebras | Free tier, OpenAI-compatible API, different speed/latency profile - enables real cost+latency routing demo |

### Request Flow

```
Client Request (Bearer: sk-tenant-xxx)
        |
        v
[Auth Middleware] --> lookup tenant by API key --> 401 if not found
        |
        v
[Rate Limiter] --> check tenant req/min limit --> 429 if exceeded
        |
        v
[Budget Enforcer] --> check tenant monthly spend cap --> 402 if exhausted
        |
        v
[Cache Lookup] --> hash(model + messages + temp) --> return cached if hit
        |
        v
[Router] --> apply routing policy (cost / latency / failover)
        |
        v
[Provider Adapter] --> normalize request shape for target provider
        |
        v
[Resilience Layer] --> retry, timeout, circuit breaker
        |
        v
[LLM Provider] (Anthropic / OpenAI / Mock)
        |
        v
[Response Normalizer] --> unified response shape
        |
        v
[Metrics Recorder] --> log tokens, cost, latency to DB
        |
        v
[Cache Writer] --> store response if cacheable
        |
        v
Client Response
```

### Directory Structure

```
switchboard/
├── src/
│   ├── server.ts              # Fastify app + plugin registration
│   ├── routes/
│   │   ├── chat.ts            # POST /v1/chat/completions
│   │   ├── metrics.ts         # GET /metrics (query by tenant/window)
│   │   ├── health.ts          # GET /health (circuit breaker states)
│   │   ├── admin.ts           # POST /admin/tenants, GET /admin/tenants/:id
│   │   └── test.ts            # POST /test/inject-failure (evaluator use)
│   ├── providers/
│   │   ├── types.ts           # Provider interface + request/response types
│   │   ├── anthropic.ts       # Anthropic Claude adapter
│   │   ├── openai.ts          # OpenAI adapter
│   │   └── mock.ts            # Mock provider for testing/failure injection
│   ├── routing/
│   │   ├── types.ts           # Router interface
│   │   ├── cost-router.ts     # Route to cheapest model meeting quality tier
│   │   ├── latency-router.ts  # Route based on p95 latency of providers
│   │   └── failover-router.ts # Waterfall: primary -> secondary on 5xx
│   ├── middleware/
│   │   ├── auth.ts            # API key extraction + tenant resolution
│   │   ├── rate-limit.ts      # Sliding window rate limiter per tenant
│   │   └── budget.ts          # Token/cost budget enforcement per tenant
│   ├── resilience/
│   │   ├── circuit-breaker.ts # CLOSED -> OPEN -> HALF_OPEN state machine
│   │   ├── retry.ts           # Exponential backoff with jitter
│   │   └── timeout.ts         # Per-request timeout wrapper
│   ├── cache/
│   │   └── response-cache.ts  # LRU + TTL, hash-keyed, streaming-aware
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema definitions
│   │   ├── client.ts          # DB connection + pool
│   │   └── migrations/        # Auto-generated migration files
│   ├── observability/
│   │   ├── logger.ts          # pino instance with request context
│   │   ├── metrics.ts         # Histogram + counters, p50/p95/p99 computation
│   │   └── tracer.ts          # trace_id propagation + span timing
│   └── config/
│       └── index.ts           # Env-driven config with validation (zod)
├── test/
│   ├── integration/
│   │   ├── multi-tenant.test.ts    # Budget isolation, rate limit isolation
│   │   ├── routing.test.ts         # Router strategy selection
│   │   ├── resilience.test.ts      # Circuit breaker, retry, timeout
│   │   └── streaming.test.ts       # SSE end-to-end, partial response handling
│   └── unit/
│       ├── circuit-breaker.test.ts
│       ├── cost-router.test.ts
│       └── cache.test.ts
├── scripts/
│   └── seed.ts               # Create demo tenants + API keys for evaluators
├── DESIGN.md
├── README.md
├── Plan.md
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Database Schema

```sql
-- tenants: config per customer
tenants (id, name, created_at, updated_at)

-- api_keys: authentication + tenant binding
api_keys (id, tenant_id, key_hash, label, created_at, revoked_at)

-- tenant_limits: rate + budget config
tenant_limits (
  id, tenant_id,
  requests_per_minute,     -- rate limit
  budget_usd_monthly,      -- spend cap
  budget_used_usd,         -- running total (reset monthly)
  allowed_providers,       -- JSON array: ["anthropic", "openai"]
  allowed_models,          -- JSON array or null (null = all)
  routing_policy,          -- "cost" | "latency" | "failover"
  created_at, updated_at
)

-- requests: audit log
requests (
  id, trace_id, tenant_id,
  requested_model, routed_provider, routed_model,
  input_tokens, output_tokens,
  cost_usd,
  latency_ms, ttfb_ms,    -- time to first byte for streaming
  status,                  -- "success" | "error" | "timeout" | "circuit_open" | "cached"
  error_code,
  cached,
  created_at
)

-- provider_health: circuit breaker state
provider_health (
  id, provider,
  state,                  -- "closed" | "open" | "half_open"
  failure_count,
  last_failure_at,
  opened_at,
  updated_at
)
```

---

## Routing Strategy - Cost Router (Primary)

The cost router is the main differentiable feature:

1. Client sends request with `model` field (concrete like "llama-3.3-70b-versatile" or abstract tier: "cheap", "balanced", "best")
2. Router has a pricing registry for every provider/model (hardcoded, config-overridable)
3. For abstract tiers, selects from eligible models in tenant's allowlist, ranked by estimated cost
4. Falls back to p95 latency for tie-breaking
5. If cheapest provider's circuit breaker is OPEN, moves to next cheapest

**Groq model pricing (example - free tier has no cost, but we model notional cost for routing logic):**
- `llama-3.1-8b-instant` (Groq) - fastest, cheapest
- `mixtral-8x7b-32768` (Groq) - mid tier
- `llama-3.3-70b-versatile` (Groq) - high quality
- `llama-3.1-70b` (Cerebras) - comparable to Groq 70B, different latency profile

Cost calculation per request:
```
estimated_cost = (input_tokens * input_price_per_1k / 1000)
              + (estimated_output_tokens * output_price_per_1k / 1000)
```

The routing demo: client sends `"model": "cheap"` -> router picks `llama-3.1-8b-instant` on Groq.
If Groq circuit is OPEN -> falls over to Cerebras `llama-3.1-70b` at the same "cheap" tier.
This is the story in the demo video.

---

## Resilience Design

### Circuit Breaker (per provider)
- CLOSED: pass through, count failures
- OPEN: reject immediately (503), set timer
- HALF_OPEN: allow 1 probe request per 30s
- Transition CLOSED -> OPEN: 5 failures in 60s window
- Transition OPEN -> HALF_OPEN: after 60s
- Transition HALF_OPEN -> CLOSED: on success
- Transition HALF_OPEN -> OPEN: on failure

### Retry Policy
- Max 3 attempts, exponential backoff: 100ms, 400ms, 1600ms + jitter
- Retry on: 429, 500, 502, 503, 504, network errors
- Do NOT retry on: 400, 401, 402, 403 (client errors)
- No retries on streaming after first byte received

### Timeouts
- Non-streaming: 30s hard timeout
- Streaming: 5s timeout for first token, 60s total
- Configurable per tenant

---

## Caching Design

Cache key: `SHA256(model + sorted_messages_json + temperature + max_tokens)`

Cacheable when:
- Non-streaming request
- Temperature = 0 (or very low, configurable threshold)
- Response status = 200

TTL:
- temp=0: 1 hour
- temp < 0.3: 15 minutes
- temp >= 0.3: no cache

Streaming: NOT cached inline. If a completed streaming response is later requested identically with streaming=false, cache hit is possible.

Race condition on same cache key: first writer wins, others get the live response. No thundering herd protection needed at this scale - document it.

---

## Observability

### Structured Logs (pino)
Every request log includes:
```json
{
  "level": "info",
  "trace_id": "...",
  "tenant_id": "...",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "latency_ms": 1243,
  "input_tokens": 512,
  "output_tokens": 128,
  "cost_usd": 0.00156,
  "cached": false,
  "status": "success"
}
```

### Metrics Endpoint
`GET /metrics?tenant=<id>&window=<1h|24h|7d>`

Returns:
```json
{
  "tenant": "...",
  "window": "24h",
  "requests": { "total": 1243, "success": 1190, "error": 53 },
  "latency": { "p50": 823, "p95": 2100, "p99": 4300 },
  "tokens": { "input": 1200000, "output": 340000 },
  "cost_usd": 18.43,
  "by_provider": { "anthropic": { ... }, "openai": { ... } },
  "by_model": { "claude-sonnet-4-6": { ... } }
}
```

### Health Endpoint
`GET /health`

Returns circuit breaker state per provider, DB connectivity, uptime.

---

## Failure Injection (for evaluators)

`POST /test/inject-failure`
```json
{
  "provider": "anthropic",
  "mode": "error_500" | "timeout" | "slow_50ms" | "reset"
}
```

This replaces the real provider adapter with the mock for that provider. The mock responds per the injected mode. `reset` restores the real adapter.

This is ONLY enabled when `ENABLE_TEST_ENDPOINTS=true` in env.

---

## What We're NOT Building (v2)

- Admin UI (no frontend per assignment rules)
- Redis for distributed caching/rate limiting (document the path)
- JWT/OAuth (simple API key auth is correct for this scope)
- Webhook delivery for async jobs
- Fine-grained RBAC within a tenant
- Multi-region deployment
- Prompt injection detection
- PII redaction

---

## Implementation Order (7 days)

**Day 1:** Schema, DB setup, Fastify scaffold, auth middleware, tenant CRUD admin endpoints
**Day 2:** Provider adapters (Anthropic + OpenAI), request/response normalization, non-streaming chat
**Day 3:** Streaming (SSE), partial response handling, streaming integration tests
**Day 4:** Routing engine (cost router + failover), circuit breaker, retry
**Day 5:** Rate limiting, budget enforcement, caching, metrics endpoint
**Day 6:** Observability polish, failure injection endpoint, seed script, integration tests
**Day 7:** DESIGN.md, README, demo video recording, final cleanup

---

## Approach Updates & Pivots

### Provider Swap: Groq + Cerebras (not Anthropic + OpenAI)
- Both are free-tier, both use OpenAI-compatible APIs
- Cerebras uses wafer-scale chips (different latency/throughput profile from Groq's LPUs)
- This actually tells a better routing story: two genuinely different inference backends
- Groq decommissioned `mixtral-8x7b-32768` and `gemma2-9b-it` mid-build - confirmed live models against their API
- Gemini support is stubbed in (adapter exists) but optional - GEMINI_API_KEY not required

### DB Driver: libsql instead of better-sqlite3
- better-sqlite3 requires native compilation (node-gyp)
- Node v24.14.0 + Windows = no pre-built binaries, build fails
- Switched to @libsql/client (Turso's pure-binary SQLite driver)
- Drizzle supports it natively, zero API surface change

### Live Model Registry (confirmed against API Jan 2026)
- Groq: `llama-3.1-8b-instant` (cheap), `meta-llama/llama-4-scout-17b-16e-instruct` (balanced), `llama-3.3-70b-versatile` (best)
- Cerebras: `llama3.1-8b` (cheap), `gpt-oss-120b` (best)

---

## Current State

### Built and verified working
- [x] Project scaffolded (Fastify 5 + TypeScript + ESM)
- [x] Database schema (5 tables: tenants, api_keys, tenant_limits, requests, provider_health)
- [x] SQLite via libsql + Drizzle ORM with migrations
- [x] Config layer with zod validation
- [x] Structured logging (pino + pino-pretty)
- [x] Groq adapter (streaming + non-streaming, real API calls working)
- [x] Cerebras adapter (streaming + non-streaming, real API calls working)
- [x] Gemini adapter (stubbed, needs GEMINI_API_KEY)
- [x] Mock adapter (error_500, timeout, slow_response, rate_limited modes)
- [x] Provider registry (real + mock, mock overrides real when active)
- [x] Cost router (picks cheapest healthy provider per tier)
- [x] Failover router (ordered fallback: groq -> cerebras -> gemini)
- [x] Circuit breaker (CLOSED/OPEN/HALF_OPEN state machine, DB-persisted)
- [x] Retry with exponential backoff + jitter
- [x] Auth middleware (Bearer API key -> tenant lookup)
- [x] Rate limiter (sliding window token bucket, per-tenant)
- [x] Budget enforcer (monthly cap with auto-reset)
- [x] Response cache (LRU + TTL, temp=0 threshold)
- [x] Chat completion endpoint (POST /v1/chat/completions)
- [x] Streaming SSE endpoint (partial response handling on upstream abort)
- [x] Metrics endpoint (GET /metrics?tenant=X&window=24h)
- [x] Health endpoint (GET /health with circuit breaker state)
- [x] Admin endpoints (POST/GET /admin/tenants, issue API keys)
- [x] Failure injection endpoint (POST /test/inject-failure)
- [x] Seed script (npm run seed - 3 demo tenants, keys printed)

### Still to build
- [ ] Integration tests (multi-tenant isolation, circuit breaker, budget exhaustion)
- [ ] DESIGN.md (start immediately - most important deliverable)
- [ ] README (setup + curl examples + failure injection guide)
- [ ] Demo video script + recording

---

## Next Steps (Priority Order)

1. **DESIGN.md** - 3-4 hours, most weight in evaluation (35%)
2. **Integration tests** - at least: multi-tenant budget isolation, circuit breaker trip/recovery, cache hit/miss
3. **README** - must include: clone-to-running in 5 min, failure injection curl commands, metrics query examples
4. **Demo video** - 8-12 min, architecture walkthrough + live demo with failure injection
