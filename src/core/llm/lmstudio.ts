import { OpenAICompatProvider } from "./provider";

export class LMStudioProvider extends OpenAICompatProvider {
  override name = "lmstudio" as const;

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async hasModel(model: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const wanted = model.toLowerCase();
      return (json.data ?? []).some((m) => m.id.toLowerCase() === wanted);
    } catch {
      return false;
    }
  }
}
