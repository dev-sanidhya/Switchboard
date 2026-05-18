import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  DATABASE_URL: z.string().default("./switchboard.db"),

  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  CEREBRAS_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  CACHE_TTL_SECONDS: z.coerce.number().default(3600),
  CACHE_MAX_ITEMS: z.coerce.number().default(500),

  CB_FAILURE_THRESHOLD: z.coerce.number().default(5),
  CB_RESET_TIMEOUT_MS: z.coerce.number().default(60000),

  RETRY_MAX_ATTEMPTS: z.coerce.number().default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().default(100),

  REQUEST_TIMEOUT_MS: z.coerce.number().default(30000),
  STREAM_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().default(5000),

  ENABLE_TEST_ENDPOINTS: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
