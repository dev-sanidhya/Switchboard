import type { FastifyInstance } from "fastify";
import { getMetrics } from "../observability/metrics.js";
import type { MetricsWindow } from "../observability/metrics.js";

const VALID_WINDOWS = new Set<MetricsWindow>(["1h", "24h", "7d"]);

export async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get("/metrics", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const tenantId = query.tenant ?? null;
    const window = (query.window ?? "24h") as MetricsWindow;

    if (!VALID_WINDOWS.has(window)) {
      return reply.code(400).send({ error: "window must be one of: 1h, 24h, 7d" });
    }

    const data = await getMetrics(tenantId, window);
    return reply.send(data);
  });
}
