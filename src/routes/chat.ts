import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { budgetMiddleware, deductBudget } from "../middleware/budget.js";
import { getRouter } from "../routing/index.js";
import { getAdapter } from "../providers/registry.js";
import { withRetry } from "../resilience/retry.js";
import { recordSuccess, recordFailure } from "../resilience/circuit-breaker.js";
import { isCacheable, cacheKey, getCached, setCached } from "../cache/response-cache.js";
import { estimateCost, MODEL_REGISTRY } from "../providers/types.js";
import { db } from "../db/client.js";
import { requests } from "../db/schema.js";
import { generateTraceId, generateId } from "../observability/tracer.js";
import { requestLogger } from "../observability/logger.js";

// Rough token estimate: 1 token ~= 4 chars
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const chatBodySchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string().max(100_000, "Single message content exceeds 100k characters"),
    })
  ).max(100, "Too many messages"),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(8192).optional(),
  stream: z.boolean().optional().default(false),
});

export async function chatRoutes(fastify: FastifyInstance) {
  // 512KB body limit - reject oversized prompts at the boundary
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 512 * 1024 },
    (req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    }
  );

  fastify.post("/v1/chat/completions", async (req, reply) => {
    const traceId = generateTraceId();
    reply.header("x-trace-id", traceId);

    // Auth -> rate limit -> budget (in order; each can short-circuit)
    await authMiddleware(req, reply);
    if (reply.sent) return;
    await rateLimitMiddleware(req, reply);
    if (reply.sent) return;
    await budgetMiddleware(req, reply);
    if (reply.sent) return;

    const ctx = req.tenantCtx!;
    const log = requestLogger(traceId, ctx.tenant.id);

    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid request body", trace_id: traceId, details: parsed.error.flatten() });
    }

    const body = parsed.data;

    // Cache check (non-streaming, deterministic requests only)
    if (!body.stream && isCacheable(body)) {
      const key = cacheKey(body);
      const cached = getCached(key);
      if (cached) {
        log.info({ event: "cache_hit", model: body.model }, "Cache hit");
        await logRequest({
          traceId,
          tenantId: ctx.tenant.id,
          requestedModel: body.model,
          routedProvider: cached.provider,
          routedModel: cached.model,
          inputTokens: cached.usage.prompt_tokens,
          outputTokens: cached.usage.completion_tokens,
          costUsd: 0,
          latencyMs: 0,
          status: "cached",
          cached: true,
          streaming: false,
        });
        return reply.send(cached);
      }
    }

    // Route the request
    const router = getRouter(ctx.limits.routingPolicy);
    let route;
    try {
      route = await router.route(body, ctx.limits);
    } catch (err) {
      log.error({ event: "routing_failed", error: String(err) }, "No eligible provider");
      await logRequest({
        traceId, tenantId: ctx.tenant.id, requestedModel: body.model,
        status: "error", errorCode: "NO_ELIGIBLE_PROVIDER", streaming: body.stream,
      });
      return reply.code(503).send({ error: "No eligible provider available", trace_id: traceId });
    }

    const adapter = getAdapter(route.provider);
    const start = Date.now();

    if (body.stream) {
      return handleStream(req, reply, { body, route, adapter, ctx, traceId, log, start });
    }

    // Non-streaming path
    try {
      const response = await withRetry(
        () => adapter.complete({ ...body, model: route.model }),
        { provider: route.provider, traceId }
      );

      await recordSuccess(route.provider);

      const latencyMs = Date.now() - start;
      const spec = MODEL_REGISTRY.find(
        (s) => s.provider === route.provider && s.modelId === route.model
      );
      const costUsd = spec
        ? estimateCost(spec, response.usage.prompt_tokens, response.usage.completion_tokens)
        : 0;

      // Atomically deduct budget. Log warning if concurrent requests raced the cap.
      if (costUsd > 0) {
        const { overBudget } = await deductBudget(ctx.tenant.id, ctx.limits.id, costUsd);
        if (overBudget) {
          log.warn(
            { event: "budget_race", tenantId: ctx.tenant.id, cost_usd: costUsd },
            "Budget cap exceeded by concurrent request; cost already incurred at provider",
          );
        }
      }

      await logRequest({
        traceId,
        tenantId: ctx.tenant.id,
        requestedModel: body.model,
        routedProvider: route.provider,
        routedModel: route.model,
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        costUsd,
        latencyMs,
        status: "success",
        cached: false,
        streaming: false,
      });

      log.info(
        { provider: route.provider, model: route.model, latency_ms: latencyMs, cost_usd: costUsd },
        "Request complete"
      );

      if (isCacheable(body)) {
        setCached(cacheKey(body), response);
      }

      return reply.send(response);
    } catch (err: any) {
      await recordFailure(route.provider);
      const latencyMs = Date.now() - start;
      const status =
        err?.name === "AbortError" || err?.code === "UND_ERR_CONNECT_TIMEOUT"
          ? "timeout"
          : "error";

      await logRequest({
        traceId,
        tenantId: ctx.tenant.id,
        requestedModel: body.model,
        routedProvider: route.provider,
        routedModel: route.model,
        latencyMs,
        status,
        errorCode: String(err?.statusCode ?? "UNKNOWN"),
        streaming: false,
      });

      log.error({ provider: route.provider, error: err.message, status }, "Request failed");

      // Only pass 400 (bad request) back to the client - it means the request itself
      // was malformed. 401/403/404 from a provider means gateway config is broken
      // (wrong API key, model not found) - that's our problem, not the tenant's.
      const httpCode = err?.statusCode === 400 ? 400 : 502;
      return reply
        .code(httpCode)
        .send({ error: err.message ?? "Upstream provider error", trace_id: traceId });
    }
  });
}

async function handleStream(
  req: any,
  reply: any,
  opts: { body: any; route: any; adapter: any; ctx: any; traceId: string; log: any; start: number }
) {
  const { body, route, adapter, ctx, traceId, log, start } = opts;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-trace-id": traceId,
  });

  // Estimate input tokens up front from the messages (same approach as cost router)
  const inputTokens = body.messages.reduce(
    (sum: number, m: { content: string }) => sum + estimateTokens(m.content),
    0
  );

  let outputTokens = 0;
  let tokensFlushed = 0;
  let ttfbMs: number | null = null;
  let abortedMidStream = false;

  try {
    const stream = adapter.stream({ ...body, model: route.model });

    for await (const chunk of stream) {
      if (ttfbMs === null) {
        ttfbMs = Date.now() - start;
      }

      const content = chunk.choices[0]?.delta?.content ?? "";
      if (content) {
        outputTokens += estimateTokens(content);
        tokensFlushed++;
      }

      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);

      if (chunk.choices[0]?.finish_reason === "stop") {
        break;
      }
    }

    reply.raw.write("data: [DONE]\n\n");
    await recordSuccess(route.provider);
  } catch (err: any) {
    abortedMidStream = tokensFlushed > 0;

    if (abortedMidStream) {
      log.warn(
        {
          provider: route.provider,
          tokens_flushed: tokensFlushed,
          error: err.message,
          event: "upstream_abort",
        },
        "Upstream dropped mid-stream, flushing partial response"
      );
      reply.raw.write("data: [PARTIAL]\n\n");
    } else {
      log.error({ provider: route.provider, error: err.message }, "Stream failed before first token");
    }

    await recordFailure(route.provider);
  } finally {
    const latencyMs = Date.now() - start;
    const spec = MODEL_REGISTRY.find(
      (s) => s.provider === route.provider && s.modelId === route.model
    );
    const costUsd = spec ? estimateCost(spec, inputTokens, outputTokens) : 0;

    // Atomically deduct when tokens were actually consumed
    if (costUsd > 0 && (outputTokens > 0 || !abortedMidStream)) {
      const { overBudget } = await deductBudget(ctx.tenant.id, ctx.limits.id, costUsd);
      if (overBudget) {
        log.warn(
          { event: "budget_race", tenantId: ctx.tenant.id, cost_usd: costUsd },
          "Budget cap exceeded by concurrent streaming request",
        );
      }
    }

    await logRequest({
      traceId,
      tenantId: ctx.tenant.id,
      requestedModel: body.model,
      routedProvider: route.provider,
      routedModel: route.model,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      ttfbMs: ttfbMs ?? undefined,
      status: abortedMidStream ? "error" : "success",
      streaming: true,
    });

    reply.raw.end();
  }
}

async function logRequest(data: {
  traceId: string;
  tenantId: string;
  requestedModel: string;
  routedProvider?: string;
  routedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  ttfbMs?: number;
  status: string;
  errorCode?: string;
  cached?: boolean;
  streaming: boolean;
}) {
  try {
    await db.insert(requests).values({
      id: generateId(),
      traceId: data.traceId,
      tenantId: data.tenantId,
      requestedModel: data.requestedModel,
      routedProvider: data.routedProvider ?? null,
      routedModel: data.routedModel ?? null,
      inputTokens: data.inputTokens ?? null,
      outputTokens: data.outputTokens ?? null,
      costUsd: data.costUsd ?? null,
      latencyMs: data.latencyMs ?? null,
      ttfbMs: data.ttfbMs ?? null,
      status: data.status,
      errorCode: data.errorCode ?? null,
      cached: data.cached ?? false,
      streaming: data.streaming,
      createdAt: new Date(),
    });
  } catch {
    // Non-fatal: logging failure must not affect the request
  }
}
