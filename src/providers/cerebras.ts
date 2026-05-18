import type { ProviderAdapter, ChatRequest, ChatResponse, StreamChunk } from "./types.js";
import { config } from "../config/index.js";

const BASE_URL = "https://api.cerebras.ai/v1";

export class CerebrasAdapter implements ProviderAdapter {
  name = "cerebras";

  isAvailable(): boolean {
    return Boolean(config.CEREBRAS_API_KEY);
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    if (!config.CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY not configured");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.CEREBRAS_API_KEY}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.7,
          max_tokens: req.max_tokens ?? 1024,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Cerebras ${res.status}: ${body}`);
        (err as any).statusCode = res.status;
        throw err;
      }

      const data = (await res.json()) as any;

      return {
        id: data.id,
        model: data.model,
        provider: "cerebras",
        choices: data.choices.map((c: any) => ({
          message: { role: c.message.role, content: c.message.content },
          finish_reason: c.finish_reason,
        })),
        usage: {
          prompt_tokens: data.usage?.prompt_tokens ?? 0,
          completion_tokens: data.usage?.completion_tokens ?? 0,
          total_tokens: data.usage?.total_tokens ?? 0,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    if (!config.CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY not configured");

    const controller = new AbortController();
    const firstTokenTimer = setTimeout(
      () => controller.abort(),
      config.STREAM_FIRST_TOKEN_TIMEOUT_MS
    );
    let firstTokenReceived = false;

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.CEREBRAS_API_KEY}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.max_tokens ?? 1024,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(firstTokenTimer);
      const body = await res.text();
      const err = new Error(`Cerebras ${res.status}: ${body}`);
      (err as any).statusCode = res.status;
      throw err;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!firstTokenReceived) {
          firstTokenReceived = true;
          clearTimeout(firstTokenTimer);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") return;

          try {
            const chunk = JSON.parse(payload) as any;
            yield {
              id: chunk.id,
              model: chunk.model,
              provider: "cerebras",
              choices: chunk.choices.map((c: any) => ({
                delta: c.delta ?? {},
                finish_reason: c.finish_reason,
              })),
            };
          } catch {
            // malformed chunk - skip
          }
        }
      }
    } finally {
      clearTimeout(firstTokenTimer);
      reader.releaseLock();
    }
  }
}
