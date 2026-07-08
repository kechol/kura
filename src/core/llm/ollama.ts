import { OpenAICompatProvider } from "./provider";

function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/:latest$/, "");
}

export class OllamaProvider extends OpenAICompatProvider {
  override name = "ollama" as const;

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async hasModel(model: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      const wanted = normalizeModelName(model);
      return (json.models ?? []).some((m) => normalizeModelName(m.name) === wanted);
    } catch {
      return false;
    }
  }
}
