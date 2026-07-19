import type { Database } from "bun:sqlite";
import { sha256Hex } from "../documents";

export type CachePurpose = "expand" | "rerank" | "tag" | "clip" | "path" | "ask";

function cacheKey(purpose: CachePurpose, model: string, input: string): string {
  return sha256Hex(`${purpose}\x00${model}\x00${input}`);
}

export function cacheGet<T>(
  db: Database,
  purpose: CachePurpose,
  model: string,
  input: string,
): T | null {
  const row = db
    .prepare("SELECT value FROM llm_cache WHERE cache_key = ?")
    .get(cacheKey(purpose, model, input)) as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function cacheSet(
  db: Database,
  purpose: CachePurpose,
  model: string,
  input: string,
  value: unknown,
): void {
  db.prepare(
    `INSERT INTO llm_cache (cache_key, purpose, value) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value`,
  ).run(cacheKey(purpose, model, input), purpose, JSON.stringify(value));
}

/** Read-through cache: return a hit, or store and return the result of fn() */
export async function cached<T>(
  db: Database,
  purpose: CachePurpose,
  model: string,
  input: string,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(db, purpose, model, input);
  if (hit !== null) return hit;
  const value = await fn();
  cacheSet(db, purpose, model, input, value);
  return value;
}
