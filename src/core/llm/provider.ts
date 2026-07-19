import type { KuraConfig } from "../config";
import { LLMUnavailableError } from "../errors";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
}

/** Strip Qwen3-style <think> reasoning blocks from a chat answer */
export function stripThinkBlocks(answer: string): string {
  return answer.replaceAll(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Local LLM provider abstraction (docs: llm-providers.md) */
export interface LLMProvider {
  name: "ollama" | "lmstudio";
  isAvailable(): Promise<boolean>;
  hasModel(model: string): Promise<boolean>;
  embed(texts: string[], model: string, dimensions?: number): Promise<Float32Array[]>;
  chat(messages: Message[], model: string, opts?: ChatOptions): Promise<string>;
}

/** Implementation based on OpenAI-compatible APIs (/v1/embeddings, /v1/chat/completions) */
export abstract class OpenAICompatProvider implements LLMProvider {
  abstract name: "ollama" | "lmstudio";

  constructor(protected baseUrl: string) {}

  abstract isAvailable(): Promise<boolean>;
  abstract hasModel(model: string): Promise<boolean>;

  protected async postJson(path: string, body: unknown, timeoutMs = 120_000): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.name} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async embed(texts: string[], model: string, dimensions?: number): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const body: Record<string, unknown> = { model, input: texts };
    if (dimensions !== undefined) body.dimensions = dimensions;
    const json = (await this.postJson("/v1/embeddings", body)) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    if (!json.data || json.data.length !== texts.length) {
      throw new Error(`${this.name} /v1/embeddings returned unexpected data`);
    }
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => Float32Array.from(d.embedding));
  }

  async chat(messages: Message[], model: string, opts: ChatOptions = {}): Promise<string> {
    const json = (await this.postJson("/v1/chat/completions", {
      model,
      messages,
      temperature: opts.temperature ?? 0,
      stream: false,
    })) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`${this.name} /v1/chat/completions returned no content`);
    }
    return content;
  }
}

interface CacheEntry {
  provider: LLMProvider | null;
  expiresAt: number;
}

let detectionCache: CacheEntry | null = null;
let testOverride: { provider: LLMProvider | null } | null = null;

/** For tests: pin the provider (null means "no provider", undefined clears the override) */
export function setProviderForTests(provider: LLMProvider | null | undefined): void {
  testOverride = provider === undefined ? null : { provider };
  detectionCache = null;
}

async function detect(config: KuraConfig): Promise<LLMProvider | null> {
  const { OllamaProvider } = await import("./ollama");
  const { LMStudioProvider } = await import("./lmstudio");
  const ollama = new OllamaProvider(config.llm.ollama_url);
  const lmstudio = new LMStudioProvider(config.llm.lmstudio_url);

  switch (config.llm.provider) {
    case "none":
      return null;
    case "ollama":
      return (await ollama.isAvailable()) ? ollama : null;
    case "lmstudio":
      return (await lmstudio.isAvailable()) ? lmstudio : null;
    default: {
      // auto: prefer Ollama, then LM Studio, then none (docs: llm-providers.md)
      if (await ollama.isAvailable()) return ollama;
      if (await lmstudio.isAvailable()) return lmstudio;
      return null;
    }
  }
}

const DETECTION_TTL_MS = 60_000;

/** Resolve the provider (detection cached in-process for 60 seconds). null when unavailable */
export async function resolveProvider(config: KuraConfig): Promise<LLMProvider | null> {
  if (testOverride) return testOverride.provider;
  const now = Date.now();
  if (detectionCache && detectionCache.expiresAt > now) return detectionCache.provider;
  const provider = await detect(config);
  detectionCache = { provider, expiresAt: now + DETECTION_TTL_MS };
  return provider;
}

/** For features that require a provider. Throws LLMUnavailableError when absent (exit 4) */
export async function requireProvider(config: KuraConfig): Promise<LLMProvider> {
  const provider = await resolveProvider(config);
  if (!provider) {
    throw new LLMUnavailableError(
      "cannot connect to an LLM provider (Ollama / LM Studio). Check that one is running, or review your settings other than 'kura config set llm.provider none'",
    );
  }
  return provider;
}
