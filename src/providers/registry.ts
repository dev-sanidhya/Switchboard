import { GroqAdapter } from "./groq.js";
import { GeminiAdapter } from "./gemini.js";
import { MockAdapter } from "./mock.js";
import type { ProviderAdapter } from "./types.js";

const groq = new GroqAdapter();
const gemini = new GeminiAdapter();

// Mock adapters sit alongside real ones. When activated via /test/inject-failure,
// the registry returns the mock instead of the real adapter.
const mocks: Record<string, MockAdapter> = {
  groq: new MockAdapter("groq"),
  gemini: new MockAdapter("gemini"),
};

const real: Record<string, ProviderAdapter> = {
  groq,
  gemini,
};

export function getAdapter(provider: string): ProviderAdapter {
  const mock = mocks[provider];
  if (mock?.isActive()) return mock;
  const adapter = real[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter;
}

export function getMockAdapter(provider: string): MockAdapter {
  const mock = mocks[provider];
  if (!mock) throw new Error(`No mock for provider: ${provider}`);
  return mock;
}

export function listProviders(): string[] {
  return Object.keys(real).filter((p) => real[p].isAvailable());
}
