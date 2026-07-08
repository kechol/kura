import { normalizeTagPath } from "./wiki";

/** import/export ラウンドトリップ用 frontmatter（SPEC §4） */
export interface Frontmatter {
  kura_key?: string;
  title?: string;
  bucket?: string;
  tags?: string[];
  source_url?: string;
  content_type?: "markdown" | "html";
  created_at?: string;
  updated_at?: string;
}

/** ISO 8601 / Date → SQLite の datetime('now') 形式（UTC "YYYY-MM-DD HH:MM:SS"） */
export function toSqliteDatetime(value: string | Date): string | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** SQLite 形式 → ISO 8601（UTC） */
export function toIsoDatetime(sqlite: string): string {
  return `${sqlite.replace(" ", "T")}Z`;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
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
 * 先頭の YAML frontmatter をパースして本文と分離する。
 * frontmatter がない場合は fm: null。YAML として不正な場合は例外を投げる（呼び出し側でファイル名を付与）。
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
  const fm: Frontmatter = {
    kura_key: asString(obj.kura_key),
    title: asString(obj.title),
    bucket: asString(obj.bucket),
    tags: asTags(obj.tags),
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

/** export 用 frontmatter を組み立てる（値は SQLite datetime 形式で受け取り ISO で出力） */
export function serializeFrontmatter(fm: {
  kura_key: string;
  title: string;
  bucket: string;
  tags: string[];
  source_url?: string | null;
  content_type?: string;
  created_at: string;
  updated_at: string;
}): string {
  const lines = ["---"];
  lines.push(`kura_key: ${fm.kura_key}`);
  lines.push(`title: ${yamlScalar(fm.title)}`);
  lines.push(`bucket: ${yamlScalar(fm.bucket)}`);
  if (fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map(yamlScalar).join(", ")}]`);
  }
  if (fm.source_url) lines.push(`source_url: ${yamlScalar(fm.source_url)}`);
  if (fm.content_type && fm.content_type !== "markdown") {
    lines.push(`content_type: ${fm.content_type}`);
  }
  lines.push(`created_at: ${toIsoDatetime(fm.created_at)}`);
  lines.push(`updated_at: ${toIsoDatetime(fm.updated_at)}`);
  lines.push("---");
  return lines.join("\n");
}
