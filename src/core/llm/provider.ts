import type { KuraConfig } from "../config";
import { LLMUnavailableError } from "../errors";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
}

/** ローカル LLM プロバイダ抽象（SPEC §6） */
export interface LLMProvider {
  name: "ollama" | "lmstudio";
  isAvailable(): Promise<boolean>;
  hasModel(model: string): Promise<boolean>;
  embed(texts: string[], model: string, dimensions?: number): Promise<Float32Array[]>;
  chat(messages: Message[], model: string, opts?: ChatOptions): Promise<string>;
}

/** OpenAI 互換 API（/v1/embeddings, /v1/chat/completions）ベースの実装 */
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

/** テスト用: プロバイダを固定する（null で「プロバイダなし」、undefined で解除） */
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
      // auto: Ollama 優先 → LM Studio → none（SPEC §6）
      if (await ollama.isAvailable()) return ollama;
      if (await lmstudio.isAvailable()) return lmstudio;
      return null;
    }
  }
}

const DETECTION_TTL_MS = 60_000;

/** プロバイダ解決（検出結果はプロセス内 60 秒キャッシュ）。不在なら null */
export async function resolveProvider(config: KuraConfig): Promise<LLMProvider | null> {
  if (testOverride) return testOverride.provider;
  const now = Date.now();
  if (detectionCache && detectionCache.expiresAt > now) return detectionCache.provider;
  const provider = await detect(config);
  detectionCache = { provider, expiresAt: now + DETECTION_TTL_MS };
  return provider;
}

/** プロバイダ必須の機能で使う。不在なら LLMUnavailableError（exit 4） */
export async function requireProvider(config: KuraConfig): Promise<LLMProvider> {
  const provider = await resolveProvider(config);
  if (!provider) {
    throw new LLMUnavailableError(
      "LLM プロバイダ（Ollama / LM Studio）に接続できません。起動状態を確認するか 'kura config set llm.provider none' 以外の設定を見直してください",
    );
  }
  return provider;
}
