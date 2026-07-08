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
  if (!mod) return; // ロード失敗時はコードブロックのまま
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
    // 構文エラー等はコードブロックのまま
  }
}

/** ドキュメント本文のレンダリング（markdown / html + mermaid 遅延ロード） */
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

  // mermaid ブロックは可視領域に入ってから CDN ロードして描画する
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

  // 内部リンクは SPA 遷移させる
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
    // biome-ignore lint/a11y/noStaticElementInteractions: 内部リンクのクリック委譲のみ（アンカー自体は操作可能）
    // biome-ignore lint/a11y/useKeyWithClickEvents: キーボード操作はアンカー要素側で担保される
    <div
      class="doc-content"
      ref={ref}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
