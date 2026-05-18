import type { ProviderAdapter, ChatRequest, ChatResponse, StreamChunk } from "./types.js";

export type FailureMode = "error_500" | "timeout" | "slow_response" | "rate_limited" | "reset";

export class MockAdapter implements ProviderAdapter {
  name: string;
  private mode: FailureMode | null = null;

  constructor(providerName: string) {
    this.name = providerName;
  }

  setMode(mode: FailureMode) {
    this.mode = mode === "reset" ? null : mode;
  }

  isActive(): boolean {
    return this.mode !== null;
  }

  isAvailable(): boolean {
    return true;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    await this.applyMode();

    return {
      id: `mock-${Date.now()}`,
      model: req.model,
      provider: this.name,
      choices: [
        {
          message: { role: "assistant", content: "Mock response for testing." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    await this.applyMode();

    const words = ["Mock", " streaming", " response", " for", " testing."];
    for (const word of words) {
      yield {
        id: `mock-${Date.now()}`,
        model: req.model,
        provider: this.name,
        choices: [{ delta: { content: word }, finish_reason: null }],
      };
      await sleep(50);
    }
    yield {
      id: `mock-${Date.now()}`,
      model: req.model,
      provider: this.name,
      choices: [{ delta: {}, finish_reason: "stop" }],
    };
  }

  private async applyMode() {
    switch (this.mode) {
      case "error_500": {
        const err = new Error(`Mock provider ${this.name} returning 500`);
        (err as any).statusCode = 500;
        throw err;
      }
      case "timeout":
        await sleep(999999);
        break;
      case "slow_response":
        await sleep(3000);
        break;
      case "rate_limited": {
        const err = new Error(`Mock provider ${this.name} returning 429`);
        (err as any).statusCode = 429;
        throw err;
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
