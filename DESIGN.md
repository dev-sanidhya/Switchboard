# Switchboard — Design Document

**Multi-Tenant LLM Gateway**
Sanidhya Shishodia — Skyclad Ventures Senior Backend Assignment

---

## 1. Problem Framing

### What problem does this gateway solve?

Every product that talks to an LLM eventually builds the same infrastructure: API key management, retry logic, cost tracking, provider fallback. They build it inside their application logic, scattered across codebases, incompatible with each other. When you run a portfolio of products — which is exactly the Skyclad use case — that means N independent implementations of the same failure modes.

Switchboard centralizes that infrastructure. Application code calls one endpoint, one auth model, and gets back a normalized response regardless of which provider actually handled it. The gateway owns rate limiting, budget enforcement, retries, circuit breaking, observability, and caching. Application code owns none of it.

### What problems is this explicitly NOT solving?

- **Prompt management / versioning.** Storing, templating, and iterating on prompts is a product problem, not infrastructure. Out of scope.
- **Fine-tuning or model deployment.** We route to inference APIs, we don't manage models.
- **Semantic routing.** Routing requests to different models based on content ("use the reasoning model for math problems") is interesting but requires understanding the request domain, which is business-logic. The gateway can support it as a custom routing policy, but doesn't implement it.
- **Conversation / session state.** We're stateless per request. History management is the application's responsibility.
- **PII redaction.** Intercepting and scrubbing sensitive data before it reaches a provider is a serious feature with legal implications. Not in v1.
- **Auth hardening beyond API keys.** This assignment uses bearer token API keys. Production would layer JWT, mTLS, or OAuth depending on the deployment model.

### Where does the responsibility boundary sit?

The gateway owns everything from "tenant sends a request" to "tenant receives a response." Upstream of that: how tenants are provisioned (admin API exists, but a real deployment would integrate with billing), how API keys are distributed securely, what happens to the response data. Downstream of the gateway: what the application does with the response, conversation memory, UI rendering.

---

## 2. Architecture

### Request Flow

```
Client
  |
  | POST /v1/chat/completions
  | Authorization: Bearer sk-xxxx
  |
  v
┌────────────────────────────────────────────────────────────────┐
│  Fastify HTTP Server (port 3000)                               │
│                                                                │
│  1. Auth Middleware                                            │
│     └─ SHA-256 hash key → lookup api_keys table               │
│     └─ Load tenant + tenant_limits                            │
│     └─ 401 if not found or revoked                            │
│                                                                │
│  2. Rate Limiter                                               │
│     └─ In-process token bucket per tenant                     │
│     └─ 429 if bucket empty                                    │
│                                                                │
│  3. Budget Enforcer                                            │
│     └─ Check budget_used_usd >= budget_usd_monthly            │
│     └─ Auto-reset if calendar month crossed                   │
│     └─ 402 if budget exhausted                                │
│                                                                │
│  4. Request Validation (zod)                                  │
│     └─ 400 if malformed; 512KB body limit enforced            │
│                                                                │
│  5. Cache Lookup (LRU + TTL)                                  │
│     └─ Key: SHA-256(model + messages + temperature)           │
│     └─ Only for temp <= 0.3, non-streaming                    │
│     └─ Return cached response immediately if hit              │
│                                                                │
│  6. Router                                                     │
│     └─ "cost" policy: picks cheapest healthy provider         │
│     └─ "failover" policy: tries groq → cerebras in order      │
│     └─ Skips providers with open circuit breakers             │
│     └─ 503 if no eligible provider                            │
│                                                                │
│  7. Resilience Wrapper                                         │
│     └─ Retry with exponential backoff (max 3 attempts)        │
│     └─ Circuit breaker check per provider                     │
│     └─ Timeout enforcement (30s non-stream, 5s TTFB stream)   │
│                                                                │
│  8. Provider Adapter                                           │
│     └─ Normalizes request shape for target provider API       │
│     └─ Groq: api.groq.com/openai/v1                           │
│     └─ Cerebras: api.cerebras.ai/v1                           │
│     └─ Both OpenAI-compatible, adapters are nearly identical  │
│                                                                │
│  9. Response Path                                              │
│     └─ Record circuit breaker success/failure                 │
│     └─ Compute cost, deduct from tenant budget                │
│     └─ Write request log to DB                                │
│     └─ Populate cache if cacheable                            │
│     └─ Return normalized response to client                   │
└────────────────────────────────────────────────────────────────┘
  |
  v
Client Response
```

### State Locations

| State | Location | Reason |
|---|---|---|
| Tenant config, API keys | SQLite (persistent) | Must survive restart |
| Request logs, token usage | SQLite (persistent) | Audit trail, metrics |
| Circuit breaker state | SQLite + in-process mirror | Survives restart; mirror reduces DB reads |
| Rate limiter state | In-process only | Acceptable loss on restart; single-instance only |
| Response cache | In-process LRU | Speed; acceptable loss on restart |

### Failure Domains

The system has three independent failure domains:

1. **Provider failure.** Groq or Cerebras is slow, returning errors, or unreachable. Circuit breaker absorbs this. Failover router routes around it. Retries handle transient 5xx.

2. **DB failure.** SQLite is embedded — the DB "failing" means the filesystem is unavailable, which also means the process is probably dying. If DB is degraded (slow writes), request logging is best-effort (writes fail silently), but the request itself still succeeds. Rate limiting and budget enforcement would be blind during DB degradation, which is an overserving risk documented below.

3. **Gateway process failure.** All in-process state (rate limiter buckets, cache) is lost. Rate limiters reset to full. Cache goes cold. Circuit breaker state is recovered from DB on next read. Tenants won't notice beyond a brief unavailability and a cache miss spike.

### What gets harder at 10x traffic?

- Rate limiting fails: buckets are per-process. At multiple instances, each bucket holds a full quota. Distributed rate limiting requires Redis INCR + EXPIRE.
- Cache hit rate drops: each instance has an independent LRU. A hot key that warmed on instance A is cold on instance B. Shared Redis cache fixes this.
- SQLite becomes the bottleneck: concurrent writes for request logging will serialize at the SQLite layer. Migration to Postgres with a connection pool is the fix.
- Circuit breaker state diverges: each instance has an independent in-memory mirror. If instance A sees 5 failures and opens the circuit, instance B hasn't seen them and continues routing to the provider. DB is authoritative but the mirror adds latency.

---

## 3. Key Decisions and Tradeoffs

### Framework: Fastify over Express

Fastify is roughly 40% faster than Express on throughput benchmarks, has TypeScript support built in, and ships schema validation via JSON Schema. The plugin system is cleaner than Express middleware chains for this layered architecture. The tradeoff: smaller ecosystem and the plugin version compatibility requirement (e.g., `@fastify/cors` must match Fastify's major version). For a gateway under load, the throughput difference earns its weight.

Alternatives considered: **Hono** (excellent, lighter, edge-first) — rejected because Fastify has more mature plugin ecosystem and better observability tooling. **Koa** — no reason to prefer it over Fastify for this use case.

### Database: SQLite (libsql) over Postgres

The assignment explicitly permits SQLite for local evaluation. The client choice — `@libsql/client` from Turso — was forced by Node v24's lack of pre-built binaries for `better-sqlite3` on Windows. `@libsql/client` provides the same embedded SQLite semantics with pure-binary distribution. Drizzle ORM's dialect can be switched from `turso` to `postgresql` with a single config change and a driver swap — the schema and query code is identical.

For production: Postgres with a connection pool (Drizzle supports it natively). SQLite breaks at the first horizontal scale event (multiple gateway instances sharing a database file).

### ORM: Drizzle over Prisma

Drizzle generates zero runtime overhead — queries are plain SQL with TypeScript types. Prisma's abstraction layer adds latency and migration complexity. For a gateway where every millisecond counts, Drizzle is the right choice. Migrations are real SQL files you can read, inspect, and run manually. The tradeoff: Drizzle's relational query API is slightly less ergonomic than Prisma's for complex nested queries — irrelevant for this use case since all queries are simple lookups.

### Routing: Cost Router as Primary Policy

The cost router computes estimated cost per request as:

```
cost = (input_tokens × input_price_per_1k / 1000)
     + (estimated_output_tokens × output_price_per_1k / 1000)
```

Input tokens are estimated from message character counts (1 token ≈ 4 chars). Output tokens are estimated from `max_tokens` or a default. The router sorts candidate models by estimated cost and picks the cheapest healthy one.

This is more defensible than round-robin (which ignores cost) or latency-only (which ignores budget). The tradeoff: the cost estimate is wrong. Real tokenizers don't use character counts; multilingual text can tokenize very differently; output length estimation is speculative. In production, you'd use the provider's tokenizer or the actual token count from the previous response to adjust the pricing registry.

Why not latency routing? Latency-aware routing requires tracking rolling p95 latencies per provider. That's another table, more writes, more reads. For the assignment scope, cost routing gives a more concrete demo story. A real deployment would layer latency into the cost calculation.

### Caching: Temperature Threshold at 0.3

Requests with `temperature <= 0.3` are treated as "sufficiently deterministic" to cache. This is a deliberate simplification — temperature 0 is fully deterministic; temperature 0.3 occasionally produces different outputs. The TTL (1 hour by default) further bounds the staleness risk.

What we do NOT cache: streaming responses. Replaying a cached stream would require buffering the entire response and replaying the SSE chunks, which adds complexity for limited benefit. A client asking for a streaming response probably wants real-time token delivery, not a buffered replay.

The cache invalidation strategy is TTL-only. There is no explicit invalidation path. This is correct for deterministic completions — if the model version changes (i.e., the provider deploys a new version behind the same model name), cached responses could become inconsistent. This is a known limitation documented in failure modes.

### Resilience: Circuit Breaker per Provider

The circuit breaker is a three-state machine: CLOSED (normal), OPEN (rejecting requests), HALF_OPEN (probing). Transition thresholds are configurable via environment variables (`CB_FAILURE_THRESHOLD`, `CB_RESET_TIMEOUT_MS`).

Why not a simple failure counter with backoff? Circuit breakers are the correct primitive here because they protect the downstream provider from being hammered while sick. A simple counter with retry doesn't prevent other requests from also failing while the provider is down. The circuit breaker stops new requests from reaching a known-bad provider, not just one request.

The per-provider granularity is important. A Groq outage should not affect Cerebras traffic. A global circuit breaker would conflate independent failure domains.

### Providers: Groq + Cerebras (not Anthropic + OpenAI)

Both providers are free-tier with OpenAI-compatible APIs. The adapter code is nearly identical (different `BASE_URL` only). This demonstrates the "unified API surface" requirement while keeping operating cost at zero for evaluation.

More importantly: Groq and Cerebras have genuinely different infrastructure (LPU vs wafer-scale) and different speed/cost profiles. The cost router can make real decisions between them. LiteLLM and Portkey support both natively — we chose to implement the adapters directly rather than use those libraries (per assignment rules), but the design mirrors what they do internally: a thin normalization layer over OpenAI-compatible endpoints.

---

## 4. Failure Modes

These are the honest answers, not the sanitized version.

**What happens if Groq is slow but not failing?**

Requests to Groq will consume the 30-second request timeout and eventually abort. The retry logic will attempt up to 3 times with backoff, meaning a single "slow" request can tie up resources for up to ~2 minutes (30s × 3 attempts with backoff delays). The circuit breaker uses failure count, not latency — a provider that always succeeds after 29 seconds looks healthy to the circuit breaker. Production fix: track p95 latency and add latency-based circuit tripping.

**What happens if the DB is partitioned from the app server?**

Auth fails (can't look up API keys). All requests return 502. Rate limiting and budget enforcement are unavailable. The gateway is completely down. There's no graceful degradation when the DB is unavailable, because tenant data lives there — we can't safely serve traffic without it. A caching layer in front of the tenant lookup (warm on startup, stale for 60s) would provide short-term resilience. Not implemented.

**What happens if a tenant sends a 200KB prompt?**

The 512KB body limit at the Fastify layer will reject payloads over that size with 413. A prompt under 512KB but still very large (say 100KB) will: pass the body limit, get routed, and potentially be rejected by the provider (Groq has a 32k token context limit for some models; Cerebras has 8k for llama3.1-8b). The provider rejection returns 400 or a model-specific error. Cost estimation is off for large prompts because our character-count heuristic assumes English text; CJK characters tokenize very differently.

**What happens if two tenants race the same cache key?**

Two identical concurrent requests (same model, messages, temperature) from the same or different tenants will both miss the cache (no entry yet), both route to the provider, both get responses, and both write to the cache. The second write overwrites the first — last writer wins. No thundering herd protection. At single-instance scale with an LRU this is acceptable (the extra provider call is wasteful, not incorrect). At high concurrency, a "lock on cache miss" pattern using a promise map would prevent duplicate provider calls for the same key. Not implemented.

**What happens if two tenants race the budget check?**

Budget is checked (`budgetUsedUsd >= budgetUsdMonthly`) against a value loaded at request start. Two concurrent requests from a tenant near their budget cap can both pass the check, both make provider calls, and both deduct from the budget. The actual deduction uses a SQL increment (`budget_used_usd + cost`) which is atomic, but the pre-flight check is not. A tenant can overspend by up to (concurrent_requests × max_cost_per_request) above their cap. For a $0.10 monthly cap with typical request costs of $0.001, the overage is bounded. Proper fix: add `budget_used_usd + cost <= budget_usd_monthly` as a WHERE clause on the UPDATE and reject if 0 rows updated. Not implemented.

**What happens if a provider drops the connection mid-stream after 50 tokens?**

The streaming handler catches the error, emits `data: [PARTIAL]\n\n` as the final SSE event (so the client knows the stream was cut), logs the event with `tokens_flushed` count, records a circuit breaker failure, and closes the connection cleanly. The client receives a partial response and a signal that it was partial. Cost is calculated from the tokens actually generated. This is one of the places where the code goes beyond the happy path.

**What happens if two instances run simultaneously?**

Rate limiting: each instance has a full per-tenant bucket. A tenant configured for 60 req/min gets 120 req/min across two instances. The rate limit is functionally doubled. This is documented as a known single-instance limitation.

Circuit breaker state: each instance has an independent in-memory cache. DB is authoritative, but instances only read DB state on cache miss (first request per provider after a restart or eviction). If one instance opens a circuit, other instances will continue routing to the unhealthy provider until they accumulate enough failures of their own.

---

## 5. What We Didn't Build

**Distributed rate limiting.** In-process token buckets mean horizontal scaling doubles the effective rate limit. Fix: Redis INCR + EXPIRE sliding window, or Upstash Rate Limit (Redis-backed managed service). Estimated effort: 2 days. Punted because it adds a Redis dependency for local setup.

**Redis cache.** Each gateway instance has an independent LRU. Cache warming on one instance doesn't help another. Fix: Redis with TTL, same cache key structure as today. Estimated effort: 1 day. Punted for same reason as distributed rate limiting.

**Latency-aware routing.** The cost router picks by price. Adding p95 latency as a tie-breaking dimension (or as a primary dimension via configurable policy) would require tracking rolling latency in the DB and reading it per routing decision. Estimated effort: 1 day.

**Connection pooling for the DB.** libsql handles this internally, but a dedicated pool manager (pg-pool for Postgres) would give more control over connection limits. Relevant when migrating to Postgres under load.

**Proper tenant provisioning flow.** The admin API creates tenants with no auth. In production, tenant creation would be gated by billing, and API keys would be delivered via a secure channel (not in a JSON response body). This is a security gap documented in the production gap analysis.

**Prompt injection detection.** Malicious tenants could craft prompts that attempt to jailbreak models or exfiltrate information from other tenants' context (if any context were shared, which it isn't in this design). A classifier at the input boundary would catch obvious injection attempts. Not implemented.

**Webhook delivery for async completions.** Long-running completions should ideally be queued and delivered via webhook rather than held open as a long HTTP connection. The current design is synchronous — the client connection stays open for the full duration. Not implemented.

**Fine-grained RBAC within a tenant.** All API keys for a tenant have identical permissions. Production would allow scoped keys (read-only metrics, specific model allowlists, etc.). Not implemented.

**What I would redesign if starting over.** The circuit breaker's in-process mirror creates a maintenance burden (clearInMemoryState was needed in tests to prevent stale state). I'd move to a simple DB-only circuit breaker for v1 (reads on every request are cheap at this scale) and add the mirror only when benchmarks showed it mattered. The performance gain from the mirror is real but the complexity cost is higher than I expected.

---

## 6. Production Gap Analysis

### Gap 1: Auth hardening

The current auth model: bearer tokens that are SHA-256 hashes of raw API keys. The raw key is returned once at creation and never stored. The hash is stored. This is correct.

What's missing: rate limiting on the auth lookup itself (prevent enumeration), key rotation without downtime (can issue new key, then revoke old), and audit logging of key issuance/revocation events. Closing this gap: 2-3 days of engineering. The DB schema already supports multiple keys per tenant and revocation timestamps — the missing piece is the operational tooling around it.

### Gap 2: Secrets management

Provider API keys (`GROQ_API_KEY`, `CEREBRAS_API_KEY`) live in environment variables. In production, these belong in a secrets manager (Vault, AWS Secrets Manager, Doppler). Rotation requires a process restart with the current design. Closing this gap: 1 day for the integration, plus coordination with DevOps for the secrets store choice.

### Gap 3: Deployment story

There is no Dockerfile, no docker-compose for production, no Kubernetes manifests, no CI/CD pipeline. The service has no health check endpoint path configured for load balancers (the `/health` endpoint exists, but the Dockerfile to containerize it doesn't). Closing this gap: 1-2 days for containerization + basic CI (GitHub Actions for lint/test on PR).

### Gap 4: Load testing

We have no benchmark numbers. We don't know where the gateway saturates. Before putting this in front of paying customers, I'd want:
- Baseline latency at p50/p95/p99 under 100 concurrent clients
- Maximum sustained RPS before latency degrades past SLA
- DB write throughput (request logging is on the hot path)
- Memory profile under sustained load (LRU cache growth, DB connection pool)

Tool: k6 or wrk against a mock provider, 30-minute sustained load test. Estimated effort: 1 day to set up, 2 days to interpret and fix what it finds.

### Gap 5: On-call runbook

The metrics endpoint (`GET /metrics`) and health endpoint (`GET /health`) give operators the data they need, but there's no runbook for what to do with it. Key operational questions without answers: how do you manually reset a circuit breaker in production? (You can POST to `/test/inject-failure` with `mode: "reset"`, but that endpoint should be locked down in production.) What's the procedure for rotating a provider API key without dropping requests? How do you diagnose a latency spike — is it the provider, the DB, or the gateway itself? Closing this gap: 2 days to write a realistic runbook based on the architecture.

---

## 7. Scaling Story

### At 10 RPS

The current design handles this without modification. SQLite can sustain hundreds of writes per second under WAL mode. The in-process LRU cache will warm up quickly. Rate limiting works correctly with a single instance. Circuit breaker state is consistent. No external dependencies.

Bottleneck at this scale: provider latency. If Groq has a 500ms p95 response time, 10 RPS with a 30s timeout means up to 300 concurrent open connections at peak. Node.js handles this fine with its async I/O model, but connection pooling to the providers becomes important.

### At 1000 RPS

**First cliff: SQLite.** Request logging writes a row per request. At 1000 RPS, that's 1000 writes/second to a single SQLite file. SQLite WAL mode handles concurrent reads, but writes serialize. On a fast SSD this might hold for a while, but you'd see write latency increasing. Migration path: Postgres with a connection pool, async write queue for logging (fire-and-forget — losing a log entry is acceptable, blocking the request on it is not).

**Second cliff: in-process rate limiting.** At 1000 RPS you need horizontal scaling (multiple instances). But in-process rate limiting breaks at >1 instance. Redis with Lua scripting for atomic INCR + EXPIRE is the fix.

**Third cliff: cache invalidation at scale.** With multiple instances, each has an independent cold cache. Stampede on cache miss with 1000 RPS and a 200ms provider latency means potentially 200 in-flight requests for the same cache key simultaneously. A Redis-backed shared cache with a "lock on miss" pattern solves this.

At 1000 RPS, you'd be running 3-5 gateway instances behind a load balancer, with Postgres for the DB and Redis for rate limiting + cache. The request logging could move to an async write buffer (batch 100 rows at a time, flush every 100ms).

### At 100k RPS

**The gateway itself is not the bottleneck.** Fastify on Node.js can handle ~50-80k RPS per process for simple routing logic, with multiple processes behind a load balancer. At 100k RPS you'd run 3-5 instances.

**The bottleneck is the providers.** Groq's free tier has global rate limits. Cerebras's free tier is similar. At 100k RPS you are not using free tier providers — you're on enterprise contracts with dedicated capacity. The routing logic needs to track per-provider rate limit quotas (not just circuit breakers) and distribute requests across multiple API keys per provider.

**DB at 100k RPS.** Request logging at 100k events/second is not a database problem — it's a streaming analytics problem. The right architecture: Kafka/Kinesis for the event stream, with a consumer that writes to a time-series DB (ClickHouse, TimescaleDB) for the metrics queries. The SQLite/Postgres model breaks here.

**What breaks first at 100k RPS:** Provider rate limits, then the synchronous request logging write path, then the Redis rate limiter (which would need to be sharded). The routing logic, circuit breakers, and cache logic scale horizontally without major redesign.

---

## Appendix: References

- **LiteLLM** — the most widely-used LLM proxy. Uses Python, supports 100+ providers, has a complex routing implementation. Our cost routing logic is similar to their `lowest_cost` routing strategy, but we built the abstraction layer directly rather than wrapping their library.
- **Portkey** — production LLM gateway with observability focus. Their semantic caching is more sophisticated than our temperature-based threshold.
- **Helicone** — proxy + observability platform. We implemented the same request logging model but without their dashboard UI.
- **Upstash** — we'd use their Redis and Rate Limit products to close the distributed rate limiting gap in production.
