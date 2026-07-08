import { useEffect, useMemo, useRef } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { loadMermaid, renderMarkdown, sanitizeHtml, type WikiResolver } from "../markdown";

interface Props {
  content: string;
  contentType: string;
  resolve?: WikiResolver;
}

let mermaidSeq = 0;

async function renderMermaidBlock(code: HTMLElement): Promise<void> {
  const mod = await loadMermaid();
  if (!mod) return; // Keep the plain code block when loading fails
  const pre = code.closest("pre");
  if (!pre) return;
  try {
    mermaidSeq += 1;
    const { svg } = await mod.default.render(`kura-mermaid-${mermaidSeq}`, code.textContent ?? "");
    const wrapper = document.createElement("div");
    wrapper.className = "mermaid-diagram";
    wrapper.innerHTML = svg;
    pre.replaceWith(wrapper);
  } catch {
    // Keep the code block on syntax errors etc.
  }
}

/** Document body rendering (markdown / html + lazy mermaid loading) */
export function DocContent({ content, contentType, resolve }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [, navigate] = useLocation();

  const html = useMemo(
    () =>
      contentType === "html"
        ? sanitizeHtml(content)
        : renderMarkdown(content, resolve ?? (() => null)),
    [content, contentType, resolve],
  );

  // Mermaid blocks load from the CDN and render only once they enter the viewport
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const blocks = root.querySelectorAll<HTMLElement>("code.language-mermaid");
    if (blocks.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        void renderMermaidBlock(entry.target as HTMLElement);
      }
    });
    for (const b of blocks) observer.observe(b);
    return () => observer.disconnect();
  }, [html]);

  // Navigate internal links via the SPA router
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const anchor = (e.target as Element).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("/")) {
      e.preventDefault();
      navigate(href);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click delegation for internal links only (the anchors themselves are interactive)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is guaranteed by the anchor elements
    <div
      class="doc-content"
      ref={ref}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
