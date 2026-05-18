import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMockAdapter } from "../providers/registry.js";
import { resetCircuit } from "../resilience/circuit-breaker.js";
import { config } from "../config/index.js";
import type { FailureMode } from "../providers/mock.js";

const injectSchema = z.object({
  provider: z.string(),
  mode: z.enum(["error_500", "timeout", "slow_response", "rate_limited", "success", "reset"]),
});

// Test endpoints are only available when ENABLE_TEST_ENDPOINTS=true.
// NEVER enable in production.
export async function testRoutes(fastify: FastifyInstance) {
  if (!config.ENABLE_TEST_ENDPOINTS) return;

  fastify.post("/test/inject-failure", async (req, reply) => {
    const parsed = injectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const { provider, mode } = parsed.data;
    try {
      const mock = getMockAdapter(provider);
      mock.setMode(mode as FailureMode);

      if (mode === "reset") {
        // Also reset the circuit breaker so the provider becomes healthy again
        await resetCircuit(provider);
        return reply.send({ provider, mode, message: "Mock cleared and circuit breaker reset" });
      }

      return reply.send({
        provider,
        mode,
        message: `Provider ${provider} will now respond with: ${mode}`,
      });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.get("/test/status", async (_req, reply) => {
    return reply.send({
      test_endpoints: true,
      warning: "Test endpoints active - do not use in production",
    });
  });
}
