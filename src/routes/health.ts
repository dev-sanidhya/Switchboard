import type { FastifyInstance } from "fastify";
import { getCircuitStates } from "../resilience/circuit-breaker.js";
import { getCacheStats } from "../cache/response-cache.js";
import { listProviders } from "../providers/registry.js";
import { db } from "../db/client.js";

const startTime = Date.now();

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (_req, reply) => {
    let dbOk = true;
    try {
      db.run("SELECT 1");
    } catch {
      dbOk = false;
    }

    const circuits = await getCircuitStates();
    const configuredProviders = listProviders();

    return reply.send({
      status: dbOk ? "ok" : "degraded",
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      db: dbOk ? "ok" : "error",
      providers: circuits,
      configured_providers: configuredProviders,
      cache: getCacheStats(),
    });
  });
}
