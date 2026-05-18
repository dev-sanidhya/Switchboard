import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config/index.js";
import { logger } from "./observability/logger.js";
import { chatRoutes } from "./routes/chat.js";
import { metricsRoutes } from "./routes/metrics.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { testRoutes } from "./routes/test.js";
import { db } from "./db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const fastify = Fastify({
    logger: false, // Using pino directly for structured logs
    trustProxy: true,
  });

  await fastify.register(cors, { origin: false });

  // Request lifecycle: assign trace ID, log on response
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

async function main() {
  // Run migrations on startup
  migrate(db, {
    migrationsFolder: path.join(__dirname, "db", "migrations"),
  });
  logger.info("Database migrations applied");

  const fastify = await buildServer();

  try {
    await fastify.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        test_endpoints: config.ENABLE_TEST_ENDPOINTS,
      },
      `Switchboard running`
    );
  } catch (err) {
    logger.error(err, "Server failed to start");
    process.exit(1);
  }
}

main();
