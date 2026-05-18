import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { config } from "../config/index.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const libsql = createClient({ url: `file:${config.DATABASE_URL}` });
const db = drizzle(libsql);

await migrate(db, { migrationsFolder: path.join(__dirname, "migrations") });
console.log("Migrations complete");
await libsql.close();
