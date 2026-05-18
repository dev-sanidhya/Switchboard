import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "turso",
  dbCredentials: {
    url: `file:${process.env.DATABASE_URL ?? "./switchboard.db"}`,
  },
} satisfies Config;
