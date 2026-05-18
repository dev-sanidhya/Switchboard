import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config/index.js";
import { logger } from "./observability/logger.js";
import { chatRoutes } from "./routes/chat.js";
import { metricsRoutes } from "./routes/metrics.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { testRoutes } from "./routes/test.js";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const fastify = Fastify({
    logger: false,
    trustProxy: true,
  });

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

async function main() {
  const libsql = createClient({ url: `file:${config.DATABASE_URL}` });
  const db = drizzle(libsql);
  await migrate(db, { migrationsFolder: path.join(__dirname, "db", "migrations") });
  logger.info("Database migrations applied");

  const fastify = await buildServer();

  try {
    await fastify.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, test_endpoints: config.ENABLE_TEST_ENDPOINTS },
      "Switchboard running"
    );
  } catch (err) {
    logger.error(err, "Server failed to start");
    process.exit(1);
  }
}

main();
