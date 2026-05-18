import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config/index.js";
import { logger } from "./observability/logger.js";
import { chatRoutes } from "./routes/chat.js";
import { metricsRoutes } from "./routes/metrics.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { testRoutes } from "./routes/test.js";

export async function buildServer() {
  const fastify = Fastify({ logger: false, trustProxy: true });

  await fastify.register(cors, { origin: false });

  fastify.addHook("onRequest", async (req) => {
    (req as any).startTime = Date.now();
  });

  fastify.addHook("onResponse", async (req, reply) => {
    const duration = Date.now() - ((req as any).startTime ?? Date.now());
    logger.info(
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        duration_ms: duration,
        trace_id: reply.getHeader("x-trace-id"),
      },
      "http"
    );
  });

  await fastify.register(healthRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(adminRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(testRoutes);

  return fastify;
}
