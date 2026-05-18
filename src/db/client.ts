import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import { config } from "../config/index.js";

const libsql = createClient({ url: `file:${config.DATABASE_URL}` });

export const db = drizzle(libsql, { schema });
export type DB = typeof db;
