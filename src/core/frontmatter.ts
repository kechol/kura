import { normalizeDocPath, normalizeTagPath } from "./wiki";

/** Frontmatter for import/export round-trips (docs: document-notation.md) */
export interface Frontmatter {
  kura_key?: string;
  title?: string;
  bucket?: string;
  /** Document path; '' is an explicit bucket root, undefined means the key was absent */
  path?: string;
  tags?: string[];
  /** Sidebar pin; absent means "leave whatever the store has" */
  favorite?: boolean;
  source_url?: string;
  content_type?: "markdown" | "html";
  created_at?: string;
  updated_at?: string;
}

/** ISO 8601 / Date to SQLite datetime('now') format (UTC "YYYY-MM-DD HH:MM:SS") */
export function toSqliteDatetime(value: string | Date): string | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** SQLite format to ISO 8601 (UTC) */
export function toIsoDatetime(sqlite: string): string {
  return `${sqlite.replace(" ", "T")}Z`;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return undefined;
}

/** Unlike asString, an empty string is kept — it is an explicit bucket root */
function asDocPath(v: unknown): string | undefined {
  return typeof v === "string" ? normalizeDocPath(v) : undefined;
}

/** Accept the YAML booleans and the strings a hand-written file may carry */
function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes") return true;
    if (s === "false" || s === "no") return false;
  }
  return undefined;
}

function asDatetime(v: unknown): string | undefined {
  if (v instanceof Date) return toSqliteDatetime(v) ?? undefined;
  if (typeof v === "string") return toSqliteDatetime(v) ?? undefined;
  return undefined;
}

function asTags(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!raw) return undefined;
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = normalizeTagPath(item);
    if (normalized && !tags.includes(normalized)) tags.push(normalized);
  }
  return tags;
}

/**
 * Parse the leading YAML frontmatter and separate it from the body.
 * fm is null when there is no frontmatter. Throws on invalid YAML (callers attach the file name).
 */
export function parseFrontmatter(raw: string): { fm: Frontmatter | null; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: null, body: raw };
  const parsed = Bun.YAML.parse(m[1] ?? "");
  const body = raw.slice(m[0].length);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { fm: null, body };
  }
  const obj = parsed as Record<string, unknown>;
  const contentType = asString(obj.content_type);
  // Also rescue hand-written frontmatter where an all-digit key is unquoted
  const rawKey = obj.kura_key;
  const kuraKey =
    typeof rawKey === "number" && Number.isSafeInteger(rawKey) ? String(rawKey) : asString(rawKey);
  const fm: Frontmatter = {
    kura_key: kuraKey,
    title: asString(obj.title),
    bucket: asString(obj.bucket),
    path: asDocPath(obj.path),
    tags: asTags(obj.tags),
    favorite: asBoolean(obj.favorite),
    source_url: asString(obj.source_url),
    content_type:
      contentType === "html" ? "html" : contentType === "markdown" ? "markdown" : undefined,
    created_at: asDatetime(obj.created_at),
    updated_at: asDatetime(obj.updated_at),
  };
  return { fm, body };
}

function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

/** Build frontmatter for export (accepts SQLite datetime values, emits ISO) */
export function serializeFrontmatter(fm: {
  kura_key: string;
  title: string;
  bucket: string;
  path: string;
  tags: string[];
  favorite?: boolean;
  source_url?: string | null;
  content_type?: string;
  created_at: string;
  updated_at: string;
}): string {
  const lines = ["---"];
  // Always quote doc_key: it can be all digits (prevents YAML number coercion)
  lines.push(`kura_key: ${yamlScalar(fm.kura_key)}`);
  lines.push(`title: ${yamlScalar(fm.title)}`);
  lines.push(`bucket: ${yamlScalar(fm.bucket)}`);
  if (fm.path !== "") lines.push(`path: ${yamlScalar(fm.path)}`);
  if (fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map(yamlScalar).join(", ")}]`);
  }
  // Only written when set: an absent key leaves the flag alone on import
  if (fm.favorite) lines.push("favorite: true");
  if (fm.source_url) lines.push(`source_url: ${yamlScalar(fm.source_url)}`);
  if (fm.content_type && fm.content_type !== "markdown") {
    lines.push(`content_type: ${fm.content_type}`);
  }
  lines.push(`created_at: ${toIsoDatetime(fm.created_at)}`);
  lines.push(`updated_at: ${toIsoDatetime(fm.updated_at)}`);
  lines.push("---");
  return lines.join("\n");
}
