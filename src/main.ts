import { buildServer } from "./server.js";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { config } from "./config/index.js";
import { logger } from "./observability/logger.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
