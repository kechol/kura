import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import MarkdownIt from "markdown-it";
import { currentTheme } from "./theme";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

/** Resolve [[Title]] → doc_key. null when unresolved */
export type WikiResolver = (title: string) => string | null;

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight: (code, lang) => {
    if (lang && lang !== "mermaid" && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // Fall back to plain code when highlighting fails
      }
    }
    return "";
  },
});

// Inline rule that turns [[links]] into clickable internal links (docs: browser-ui.md)
md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const title = src.slice(pos + 2, end).trim();
  if (title === "" || title.includes("\n") || title.includes("[")) return false;
  if (!silent) {
    const token = state.push("wikilink", "a", 0);
    token.content = title;
  }
  state.pos = end + 2;
  return true;
});

md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
  const title = tokens[idx]?.content ?? "";
  const resolve = (env as { resolve?: WikiResolver }).resolve;
  const key = resolve ? resolve(title) : null;
  const label = md.utils.escapeHtml(title);
  if (key) {
    return `<a class="wikilink" href="/docs/${encodeURIComponent(key)}">${label}</a>`;
  }
  // Unresolved link: route to the title-resolution page (rendered in red)
  return `<a class="wikilink wikilink-unresolved" href="/docs/title/${encodeURIComponent(title)}">${label}</a>`;
};

/** markdown → HTML (always passes through DOMPurify as the final step) */
export function renderMarkdown(content: string, resolve: WikiResolver): string {
  return DOMPurify.sanitize(md.render(content, { resolve }));
}

/** Sanitization for displaying content_type=html documents */
export function sanitizeHtml(content: string): string {
  return DOMPurify.sanitize(content);
}

const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

interface MermaidModule {
  default: {
    initialize(config: Record<string, unknown>): void;
    render(id: string, code: string): Promise<{ svg: string }>;
  };
}

let mermaidPromise: Promise<MermaidModule | null> | null = null;

/** Lazily load mermaid from the CDN. null on failure (shown as a plain code block) */
export function loadMermaid(): Promise<MermaidModule | null> {
  if (!mermaidPromise) {
    // Dynamic import via Function so the bundler does not try to resolve it
    const dynImport = new Function("u", "return import(u)") as (
      u: string,
    ) => Promise<MermaidModule>;
    mermaidPromise = dynImport(MERMAID_URL)
      .then((mod) => {
        mod.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: currentTheme() === "dark" ? "dark" : "default",
        });
        return mod;
      })
      .catch(() => null);
  }
  return mermaidPromise;
}
