import type { ComponentChildren } from "preact";
import { Link } from "wouter-preact";
import type { DocMeta } from "../api";
import { DocTitle, docHref } from "./DocLink";

/**
 * A document as a card: title, an optional body excerpt, and a foot with up to three tags
 * plus caller-supplied meta. The whole card is one <Link> — so the tags are plain <span>s,
 * never nested <a>s (that markup is invalid and swallows the card's own click).
 */
export function DocCard({
  doc,
  meta,
  cursor = false,
}: {
  doc: DocMeta;
  /** Trailing text (dates, counts) shown under the tags */
  meta?: ComponentChildren;
  /** Highlight this card as the keyboard cursor (usePageListNavigation) */
  cursor?: boolean;
}) {
  return (
    <Link href={docHref(doc.key)} class={`doc-card${cursor ? " kbd-cursor" : ""}`}>
      <span class="doc-card-title">
        <DocTitle doc={doc} />
      </span>
      {doc.excerpt !== undefined && doc.excerpt !== "" && (
        <span class="doc-card-excerpt">{doc.excerpt}</span>
      )}
      <span class="doc-card-foot">
        {doc.tags.slice(0, 3).map((t) => (
          <span key={t} class="tag-chip">
            #{t}
          </span>
        ))}
        {meta !== undefined && meta !== null && <span class="doc-card-meta">{meta}</span>}
      </span>
    </Link>
  );
}

/** A responsive grid of DocCards. `cursorIndex` marks one card as the keyboard cursor. */
export function DocCardGrid({
  docs,
  meta,
  cursorIndex,
}: {
  docs: DocMeta[];
  meta?: (doc: DocMeta) => ComponentChildren;
  cursorIndex?: number;
}) {
  return (
    <div class="doc-card-grid">
      {docs.map((d, i) => (
        <DocCard key={d.key} doc={d} meta={meta?.(d)} cursor={i === cursorIndex} />
      ))}
    </div>
  );
}
