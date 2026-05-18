import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Set env before any module is imported
    env: {
      DATABASE_URL: "./test.db",
      GROQ_API_KEY: "test-groq-key",
      CEREBRAS_API_KEY: "test-cerebras-key",
      NODE_ENV: "test",
      ENABLE_TEST_ENDPOINTS: "true",
      PORT: "3999",
      CB_FAILURE_THRESHOLD: "3",
      CB_RESET_TIMEOUT_MS: "500",
      RETRY_MAX_ATTEMPTS: "2",
      RETRY_BASE_DELAY_MS: "10",
      REQUEST_TIMEOUT_MS: "5000",
      STREAM_FIRST_TOKEN_TIMEOUT_MS: "2000",
    },
    // Run test files sequentially - they share a SQLite file DB
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15000,
  },
});
