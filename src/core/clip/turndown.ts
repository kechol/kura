import TurndownService from "turndown";

/**
 * kura's one HTML → Markdown conversion. Used by `kura clip` (mechanical fallback) and by the
 * browser editor's paste path, so HTML pasted into a document and HTML clipped from the web
 * land as the same Markdown dialect. Kept free of `bun:sqlite` so the client can import it.
 */
export function htmlToMarkdownService(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.remove(["script", "style", "iframe", "noscript"]);
  return turndown;
}

export function htmlToMarkdown(html: string): string {
  return htmlToMarkdownService().turndown(html).trim();
}
