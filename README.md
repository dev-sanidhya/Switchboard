# Switchboard

A multi-tenant LLM gateway. One API, multiple providers, per-tenant rate limits and budgets, cost-based routing, circuit breakers, streaming, and a metrics endpoint that answers "what did tenant X spend yesterday" without grepping logs.

---

## Quick Start (under 5 minutes)

### Prerequisites

- Node.js 18+ (tested on v24)
- Groq API key - free at [console.groq.com](https://console.groq.com)
- Cerebras API key (optional) - free at [inference.cerebras.ai](https://inference.cerebras.ai)

### 1. Clone and install

```bash
git clone https://github.com/dev-sanidhya/Switchboard
cd Switchboard
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=./switchboard.db
GROQ_API_KEY=gsk_your_key_here
CEREBRAS_API_KEY=csk_your_key_here   # optional
ENABLE_TEST_ENDPOINTS=true            # enables /test/inject-failure
PORT=3000
```

### 3. Seed the database and start

```bash
npm run seed      # creates 3 demo tenants, prints their API keys
npm run dev       # starts gateway on PORT (default 3000)
```

You should see:

```
{"level":"info","msg":"Switchboard listening","port":3000}
```

Copy one of the API keys printed by `npm run seed` - you'll use it in the curl examples below.

---

## Architecture

```
Client
  │
  ▼
POST /v1/chat/completions
  │
  ├── Auth middleware         (SHA-256 API key lookup)
  ├── Rate limit middleware   (sliding window token bucket, per-tenant)
  ├── Budget middleware       (atomic SQL check against monthly cap)
  │
  ├── Cache check             (LRU, keyed by SHA-256 of model+messages+temp)
  │
  ├── Router                  (cost or failover, respects circuit breaker state)
  │
  └── Provider adapter
        ├── Groq              (llama-3.1-8b / llama-4-scout / llama-3.3-70b)
        ├── Cerebras          (llama3.1-8b / gpt-oss-120b)
        └── Mock              (test-only, injected via /test/inject-failure)
```

All requests are logged to SQLite. Circuit breaker state is persisted to `provider_health` table and mirrored in-process.

---

## API Reference

### Chat completions

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-tenant-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cheap",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

**Model tiers** (abstract names the gateway resolves):

| Tier | Groq model | Cerebras model |
|------|-----------|----------------|
| `cheap` | llama-3.1-8b-instant | llama3.1-8b |
| `balanced` | meta-llama/llama-4-scout-17b-16e-instruct | - |
| `best` | llama-3.3-70b-versatile | gpt-oss-120b |

You can also pass concrete model names - the router matches by modelId in the registry.

**Streaming:**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-tenant-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cheap",
    "messages": [{"role": "user", "content": "Count to 10 slowly"}],
    "stream": true
  }'
```

Emits SSE chunks (`data: {...}\n\n`). If the upstream drops mid-stream, you receive `data: [PARTIAL]\n\n` as the final event - never a connection abort without signal.

### Health

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "db": "ok",
  "configured_providers": ["groq", "cerebras"],
  "providers": {
    "groq": "closed",
    "cerebras": "closed"
  },
  "cache": {"size": 0, "max": 1000, "ttl_seconds": 300},
  "uptime_s": 42
}
```

### Metrics

```bash
# Spend for YOUR tenant (auth via bearer; ?tenant= ignored if it doesn't match)
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:3000/metrics?window=24h"

# Supported windows: 1h, 24h, 7d
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:3000/metrics?window=1h"

# Admins can query any tenant or omit ?tenant= for global view
curl -H "X-Admin-Key: $ADMIN_API_KEY" \
  "http://localhost:3000/metrics?tenant=TENANT_ID&window=24h"
```

The `/metrics` endpoint requires authentication. A tenant Bearer token returns metrics scoped to that tenant only (cross-tenant queries get `403`). An admin `X-Admin-Key` can query any tenant or omit `?tenant=` for an aggregate view across all tenants.

```json
{
  "tenant": "ten_abc123",
  "window": "24h",
  "requests": {"total": 47, "success": 45, "errors": 2, "cached": 8},
  "latency_ms": {"p50": 312, "p95": 890, "p99": 1240},
  "tokens": {"input": 12400, "output": 3800},
  "cost_usd": 0.00082,
  "by_provider": {"groq": 0.00071, "cerebras": 0.00011},
  "by_model": {
    "llama-3.1-8b-instant": 0.00041,
    "llama-3.3-70b-versatile": 0.0003,
    "llama3.1-8b": 0.00011
  }
}
```

### Admin - tenant management

Admin routes require `X-Admin-Key: <your-key>` when `ADMIN_API_KEY` is set in env. Without it, admin routes are open (dev only — always set this in production).

```bash
# Create a tenant
curl -X POST http://localhost:3000/admin/tenants \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{
    "name": "my-app",
    "budget_usd_monthly": 10,
    "requests_per_minute": 60,
    "allowed_providers": ["groq"],
    "routing_policy": "cost"
  }'

# List all tenants
curl -H "X-Admin-Key: $ADMIN_API_KEY" http://localhost:3000/admin/tenants

# List API keys for a tenant
curl -H "X-Admin-Key: $ADMIN_API_KEY" http://localhost:3000/admin/tenants/TENANT_ID/keys

# Issue a new API key (for key rotation)
curl -X POST http://localhost:3000/admin/tenants/TENANT_ID/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"label": "v2"}'

# Revoke an old key (takes effect immediately - no restart needed)
curl -X DELETE \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  http://localhost:3000/admin/tenants/TENANT_ID/keys/KEY_ID
```

---

## Running Tests

```bash
npm test
```

73 tests across 7 files (4 unit, 3 integration). Tests run sequentially against an isolated `test.db` - no external services needed. The mock adapter system replaces real provider calls.

```
 Unit tests
   circuit-breaker.test.ts   7 tests
   cost-router.test.ts       6 tests
   failover-router.test.ts   7 tests
   cache.test.ts             12 tests

 Integration tests
   multi-tenant.test.ts      17 tests  (port 3991)
   resilience.test.ts        7 tests   (port 3992)
   routing.test.ts           17 tests  (port 3993)
```

---

## Failure Injection

Requires `ENABLE_TEST_ENDPOINTS=true` in `.env`.

### Inject a failure

```bash
# Make Groq return HTTP 500 on every request
curl -X POST http://localhost:3000/test/inject-failure \
  -H "Content-Type: application/json" \
  -d '{"provider": "groq", "mode": "error_500"}'
```

Available modes:

| Mode | Behavior |
|------|----------|
| `error_500` | Provider returns HTTP 500 |
| `timeout` | Request hangs until gateway timeout fires |
| `slow_response` | Adds 3s artificial delay |
| `rate_limited` | Provider returns HTTP 429 |
| `reset` | Restores real adapter and clears circuit |

### Watch the circuit breaker trip

```bash
# 1. Inject failures
curl -X POST http://localhost:3000/test/inject-failure \
  -d '{"provider": "groq", "mode": "error_500"}' \
  -H "Content-Type: application/json"

# 2. Make 3 requests to cross the failure threshold
for i in 1 2 3; do
  curl -s -X POST http://localhost:3000/v1/chat/completions \
    -H "Authorization: Bearer sk-your-key" \
    -H "Content-Type: application/json" \
    -d '{"model": "cheap", "messages": [{"role": "user", "content": "hi"}]}' | jq .
done

# 3. Check health - groq circuit should now be "open"
curl http://localhost:3000/health | jq .providers

# 4. New requests automatically fail over to Cerebras
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "cheap", "messages": [{"role": "user", "content": "still works?"}]}'

# 5. Reset everything
curl -X POST http://localhost:3000/test/inject-failure \
  -d '{"provider": "groq", "mode": "reset"}' \
  -H "Content-Type: application/json"

curl http://localhost:3000/health | jq .providers
# {"groq": "closed", "cerebras": "closed"}
```

---

## Full Demo Flow

```bash
# 1. Seed demo tenants
npm run seed
# Copy the "tenant-alpha" key (60 req/min, $5/month, all providers, cost routing)

export KEY="sk-copied-from-seed-output"
export TENANT_ID="ten_..."  # from GET /admin/tenants

# 2. Basic chat
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "cheap", "messages": [{"role": "user", "content": "Hello"}]}'

# 3. Streaming
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "cheap", "messages": [{"role": "user", "content": "Count to 5"}], "stream": true}'

# 4. Response caching - second identical request (temperature=0) returns cached
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "cheap", "messages": [{"role": "user", "content": "cached?"}], "temperature": 0}'
# Run again - latency drops to ~1ms, x-trace-id present

# 5. Metrics (tenant-scoped via Bearer token; ?tenant= ignored for non-admins)
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:3000/metrics?window=1h" | jq .

# Admin-scoped query (requires ADMIN_API_KEY set in .env)
curl -H "X-Admin-Key: $ADMIN_API_KEY" \
  "http://localhost:3000/metrics?tenant=$TENANT_ID&window=1h" | jq .

# 6. Inject failure + observe failover
curl -X POST http://localhost:3000/test/inject-failure \
  -H "Content-Type: application/json" \
  -d '{"provider": "groq", "mode": "error_500"}'

curl http://localhost:3000/health | jq .  # providers.groq = "open" after 3 failures

curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "cheap", "messages": [{"role": "user", "content": "failover works?"}]}'
# Routes to Cerebras automatically

# 7. Test rate limiting
export KEY2="sk-tenant-beta-key"  # 10 req/min limit
for i in $(seq 1 12); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/v1/chat/completions \
    -H "Authorization: Bearer $KEY2" \
    -H "Content-Type: application/json" \
    -d '{"model": "cheap", "messages": [{"role": "user", "content": "hi"}]}')
  echo "Request $i: HTTP $STATUS"
done
# First 10: 200/502, request 11+: 429
```

---

## Configuration Reference

| Env var | Default | Description |
|---------|---------|-------------|
| `DATABASE_URL` | `./switchboard.db` | SQLite file path |
| `GROQ_API_KEY` | required | Groq API key |
| `CEREBRAS_API_KEY` | - | Cerebras API key (optional) |
| `GEMINI_API_KEY` | - | Gemini API key (optional) |
| `PORT` | `3000` | HTTP port |
| `CACHE_TTL_SECONDS` | `3600` | Response cache TTL |
| `CACHE_MAX_ITEMS` | `500` | Max cached entries |
| `CB_FAILURE_THRESHOLD` | `5` | Failures before circuit opens |
| `CB_RESET_TIMEOUT_MS` | `60000` | Time before HALF_OPEN attempt |
| `RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts per provider call |
| `RETRY_BASE_DELAY_MS` | `100` | Base backoff delay (exponential) |
| `REQUEST_TIMEOUT_MS` | `30000` | Non-streaming request timeout |
| `STREAM_FIRST_TOKEN_TIMEOUT_MS` | `5000` | Time-to-first-token cap for streams |
| `STREAM_IDLE_TIMEOUT_MS` | `10000` | Max gap between SSE chunks before abort |
| `ADMIN_API_KEY` | - | If set, required in `X-Admin-Key` for `/admin/*` and admin-scope `/metrics` queries |
| `ENABLE_TEST_ENDPOINTS` | `false` | Exposes `/test/inject-failure` |

---

## Project Structure

```
src/
  config/        env validation (zod)
  db/            drizzle schema, migrations, client
  middleware/    auth, rate-limit, budget
  providers/     groq, cerebras, gemini, mock adapters
  resilience/    circuit-breaker, retry with backoff
  routing/       cost-router, failover-router
  cache/         LRU response cache
  routes/        chat, health, metrics, admin, test
  observability/ structured logger, tracer IDs, metrics
  main.ts        entrypoint (runs migrations, starts server)
  server.ts      buildServer() - side-effect free, used by tests

test/
  unit/          circuit-breaker, cost-router, cache (no server)
  integration/   multi-tenant, resilience, routing (real Fastify instances)
  helpers/       setupTestDb, createTestTenant, startTestServer

scripts/
  seed.ts        creates 3 demo tenants
```

---

## Observability

Every request gets a `traceId` (returned as `x-trace-id` response header). Structured logs via pino:

```json
{"level":"info","traceId":"trc_abc","tenantId":"ten_xyz","provider":"groq","model":"llama-3.1-8b-instant","latency_ms":312,"cost_usd":0.0000021,"msg":"Request complete"}
```

Mid-stream upstream aborts log:

```json
{"level":"warn","event":"upstream_abort","provider":"groq","tokens_flushed":47,"error":"socket hang up","msg":"Upstream dropped mid-stream, flushing partial response"}
```

Query request history directly:

```bash
# Using sqlite3
sqlite3 switchboard.db "
  SELECT routed_provider, routed_model, COUNT(*) as reqs, SUM(cost_usd) as spend
  FROM requests
  WHERE tenant_id = 'ten_xxx'
    AND created_at > datetime('now', '-24 hours')
  GROUP BY routed_provider, routed_model
  ORDER BY spend DESC;
"
```

---

## Running with Docker

```bash
# Build and start
cp .env.example .env  # fill in API keys
docker compose up --build

# Seed demo tenants inside the container
docker compose exec gateway node dist/scripts/seed.js  # path uses dist/scripts after build
```

The SQLite database is persisted in a Docker named volume (`switchboard_data`). Restarting the container preserves tenant config, budgets, and request logs.

---

## Known Limitations

- **Rate limiting is in-process** - not safe for horizontal scaling. Multiple instances enforce limits independently. Production fix: Redis + atomic sliding window.
- **SQLite single-writer** - concurrent writes serialize behind the WAL lock. Fine for demo and low traffic; switch to Postgres above ~50 RPS sustained.
- **Budget race bounded, not eliminated** - the pre-flight budget check and the provider call are not in the same transaction. Concurrent requests near the cap can both proceed; the deduction step closes the race atomically and clamps the DB to the cap, so worst-case overspend is one request's cost. A proper reservation pattern (reserve upfront, settle after) would eliminate it entirely.
- **Token estimation is character-count heuristic** - `chars / 4` approximates English text. CJK and other dense scripts tokenize at roughly 1 char per token, so cost routing and budget deductions can be off by 4x for non-English content.
- **No webhook on budget exhaustion** - tenant discovers via 402 on next request. Production: background job + Slack/email alert.
- **Circuit breaker state is per-instance** - same horizontal scaling issue as rate limiting.

These are documented in detail in [DESIGN.md](DESIGN.md) sections 4, 5, and 6.
