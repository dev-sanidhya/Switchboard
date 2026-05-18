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
  {
    provider: "groq",
    modelId: "llama-3.1-8b-instant",
    tier: "cheap",
    pricing: { inputPer1k: 0.00005, outputPer1k: 0.00008 },
    contextWindow: 128000,
  },
  {
    provider: "groq",
    modelId: "mixtral-8x7b-32768",
    tier: "balanced",
    pricing: { inputPer1k: 0.00024, outputPer1k: 0.00024 },
    contextWindow: 32768,
  },
  {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    tier: "best",
    pricing: { inputPer1k: 0.00059, outputPer1k: 0.00079 },
    contextWindow: 128000,
  },
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
