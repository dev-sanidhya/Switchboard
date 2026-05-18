import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as any).statusCode;
    // Don't retry client errors (400, 401, 402, 403) - they won't succeed on retry
    if (code && code < 500 && code !== 429) return false;
    if (code && RETRYABLE_STATUS_CODES.has(code)) return true;
    // Network errors (no status code) are retryable
    if (!code) return true;
  }
  return false;
}

function jitter(base: number): number {
  return base + Math.random() * base * 0.3;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  context: { provider: string; traceId: string }
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= config.RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (!isRetryable(err) || attempt === config.RETRY_MAX_ATTEMPTS) {
        throw err;
      }

      const delay = jitter(config.RETRY_BASE_DELAY_MS * Math.pow(4, attempt - 1));
      logger.warn(
        {
          provider: context.provider,
          trace_id: context.traceId,
          attempt,
          delay_ms: Math.round(delay),
          error: err instanceof Error ? err.message : String(err),
        },
        "Retrying request"
      );

      await sleep(delay);
    }
  }

  throw lastErr;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
