/** SQLite の "YYYY-MM-DD HH:MM:SS" を日付表示にする */
export function formatDate(value: string | null): string {
  if (!value) return "-";
  return value.slice(0, 10);
}

export function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return value.slice(0, 16).replace("T", " ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i] ?? "TB"}`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** スニペットの **強調** を <mark> に変換する（エスケープ後に置換） */
export function snippetHtml(snippet: string): string {
  return escapeHtml(snippet).replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>");
}
