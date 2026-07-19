/**
 * Shared JSON extraction for LLM answers: pull the first `{...}` object (or
 * `[...]` array) out of a chat reply and parse it. Returns null when nothing
 * matches or parsing fails; every post-parse default and validation stays at the
 * call site — this only extracts and parses.
 */

/** First `{...}` object in the text, JSON-parsed; null on no match / parse failure */
export function parseJsonObject<T>(answer: string): T | null {
  const m = answer.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

/** First `[...]` array in the text, JSON-parsed; null on no match / parse failure */
export function parseJsonArray<T>(answer: string): T | null {
  const m = answer.match(/\[[\s\S]*?\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}
