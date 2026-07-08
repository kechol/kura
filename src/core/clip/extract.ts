import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { KURA_VERSION } from "../paths";

export interface ExtractedPage {
  url: string;
  /** Page title (readability result preferred over <title>) */
  title: string;
  /** Extracted article HTML */
  contentHtml: string;
  excerpt: string | null;
  siteName: string | null;
}

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": `kura/${KURA_VERSION} (local knowledge management CLI)`,
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed (${res.status} ${res.statusText}): ${url}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType !== "" && !/text\/html|application\/xhtml/.test(contentType)) {
    throw new Error(`unsupported content type: ${contentType} (${url})`);
  }
  return res.text();
}

/** Extract the article body from HTML with readability + linkedom (SPEC §7.5) */
export function extractContent(url: string, html: string): ExtractedPage {
  const { document } = parseHTML(html);
  // Readability reads document.baseURI to resolve base URLs
  const article = new Readability(document as unknown as Document, {
    charThreshold: 100,
  }).parse();

  const fallbackTitle = document.querySelector("title")?.textContent?.trim() ?? url;
  if (!article || !article.content) {
    // On extraction failure, fall back to the whole body (degraded operation)
    const body = document.querySelector("body");
    if (!body) throw new Error(`failed to extract content: ${url}`);
    return {
      url,
      title: fallbackTitle,
      contentHtml: body.innerHTML,
      excerpt: null,
      siteName: null,
    };
  }
  return {
    url,
    title: article.title?.trim() || fallbackTitle,
    contentHtml: article.content,
    excerpt: article.excerpt?.trim() || null,
    siteName: article.siteName?.trim() || null,
  };
}

export async function fetchAndExtract(url: string): Promise<ExtractedPage> {
  const html = await fetchHtml(url);
  return extractContent(url, html);
}
