import { describe, it, expect, beforeEach } from "vitest";
import {
  isCacheable,
  cacheKey,
  getCached,
  setCached,
} from "../../src/cache/response-cache.js";
import type { ChatResponse } from "../../src/providers/types.js";

const baseReq = {
  model: "llama-3.1-8b-instant",
  messages: [{ role: "user" as const, content: "hello" }],
  temperature: 0,
};

const mockResponse: ChatResponse = {
  id: "test-1",
  model: "llama-3.1-8b-instant",
  provider: "groq",
  choices: [{ message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

describe("response cache", () => {
  it("marks temp=0 non-streaming request as cacheable", () => {
    expect(isCacheable({ ...baseReq, stream: false })).toBe(true);
  });

  it("marks streaming request as not cacheable", () => {
    expect(isCacheable({ ...baseReq, stream: true })).toBe(false);
  });

  it("marks high-temperature request as not cacheable", () => {
    expect(isCacheable({ ...baseReq, temperature: 1.0 })).toBe(false);
  });

  it("marks low-temperature (0.2) as cacheable", () => {
    expect(isCacheable({ ...baseReq, temperature: 0.2 })).toBe(true);
  });

  it("marks temperature at threshold (0.3) as cacheable", () => {
    expect(isCacheable({ ...baseReq, temperature: 0.3 })).toBe(true);
  });

  it("marks temperature above threshold (0.31) as not cacheable", () => {
    expect(isCacheable({ ...baseReq, temperature: 0.31 })).toBe(false);
  });

  it("generates consistent cache keys for identical requests (same tenant)", () => {
    const key1 = cacheKey(baseReq, "tenant-A");
    const key2 = cacheKey({ ...baseReq }, "tenant-A");
    expect(key1).toBe(key2);
  });

  it("generates different keys for different messages", () => {
    const key1 = cacheKey(baseReq, "tenant-A");
    const key2 = cacheKey(
      { ...baseReq, messages: [{ role: "user", content: "different" }] },
      "tenant-A",
    );
    expect(key1).not.toBe(key2);
  });

  it("generates different keys for different models", () => {
    const key1 = cacheKey(baseReq, "tenant-A");
    const key2 = cacheKey({ ...baseReq, model: "gpt-oss-120b" }, "tenant-A");
    expect(key1).not.toBe(key2);
  });

  it("generates different keys across tenants even for identical prompts (isolation)", () => {
    const key1 = cacheKey(baseReq, "tenant-A");
    const key2 = cacheKey(baseReq, "tenant-B");
    expect(key1).not.toBe(key2);
  });

  it("returns undefined for cache miss", () => {
    const key = cacheKey(
      { ...baseReq, messages: [{ role: "user", content: "cache-miss-test" }] },
      "tenant-miss",
    );
    expect(getCached(key)).toBeUndefined();
  });

  it("returns stored response on cache hit", () => {
    const key = cacheKey(baseReq, "tenant-hit");
    setCached(key, mockResponse);
    const result = getCached(key);
    expect(result).toEqual(mockResponse);
  });
});
