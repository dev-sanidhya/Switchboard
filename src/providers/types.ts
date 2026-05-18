export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatResponse {
  id: string;
  model: string;
  provider: string;
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  model: string;
  provider: string;
  choices: Array<{
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

export interface ProviderAdapter {
  name: string;
  complete(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
  isAvailable(): boolean;
}

// Pricing per 1k tokens in USD (notional for free providers - used for routing decisions)
export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
}

export interface ModelSpec {
  provider: string;
  modelId: string;
  tier: "cheap" | "balanced" | "best";
  pricing: ModelPricing;
  contextWindow: number;
}

export const MODEL_REGISTRY: ModelSpec[] = [
  // Groq - LPU inference, extremely low latency
  {
    provider: "groq",
    modelId: "llama-3.1-8b-instant",
    tier: "cheap",
    pricing: { inputPer1k: 0.00005, outputPer1k: 0.00008 },
    contextWindow: 128000,
  },
  {
    provider: "groq",
    modelId: "meta-llama/llama-4-scout-17b-16e-instruct",
    tier: "balanced",
    pricing: { inputPer1k: 0.00011, outputPer1k: 0.00034 },
    contextWindow: 131072,
  },
  {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    tier: "best",
    pricing: { inputPer1k: 0.00059, outputPer1k: 0.00079 },
    contextWindow: 128000,
  },
  // Cerebras - wafer-scale inference, different speed/cost profile from Groq
  {
    provider: "cerebras",
    modelId: "llama3.1-8b",
    tier: "cheap",
    pricing: { inputPer1k: 0.0001, outputPer1k: 0.0001 },
    contextWindow: 8192,
  },
  {
    provider: "cerebras",
    modelId: "gpt-oss-120b",
    tier: "best",
    pricing: { inputPer1k: 0.0006, outputPer1k: 0.0006 },
    contextWindow: 8192,
  },
  // Gemini - optional third provider (set GEMINI_API_KEY to enable)
  {
    provider: "gemini",
    modelId: "gemini-1.5-flash",
    tier: "cheap",
    pricing: { inputPer1k: 0.000075, outputPer1k: 0.0003 },
    contextWindow: 1000000,
  },
  {
    provider: "gemini",
    modelId: "gemini-1.5-pro",
    tier: "best",
    pricing: { inputPer1k: 0.00125, outputPer1k: 0.005 },
    contextWindow: 2000000,
  },
];

export function estimateCost(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1000) * spec.pricing.inputPer1k +
    (outputTokens / 1000) * spec.pricing.outputPer1k
  );
}
