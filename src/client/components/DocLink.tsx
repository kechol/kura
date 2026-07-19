import type { ComponentChildren } from "preact";
import { Link } from "wouter-preact";

export interface LinkableDoc {
  key: string;
  title: string;
  /** Absent where the source query does not carry one (broken-link sources, related docs) */
  path?: string;
}

/** A document's name, with its path as a muted prefix. The one place that markup lives. */
export function DocTitle({ doc }: { doc: LinkableDoc }) {
  return (
    <>
      {doc.path !== undefined && doc.path !== "" && (
        <span class="doc-path-prefix">{doc.path}/</span>
      )}
      {doc.title}
    </>
  );
}

export function docHref(key: string): string {
  return `/docs/${encodeURIComponent(key)}`;
}

/**
 * A list of links to documents, with an empty state. Used by every screen that shows a
 * secondary list of documents: related links, tidying insights, the sidebar's neighbours.
 */
export function DocLinkList<T extends LinkableDoc>({
  docs,
  class: className = "doc-links",
  exclude,
  meta,
  empty = "なし",
  cursor,
}: {
  docs: T[];
  class?: string;
  /** Document key to leave out (the one being read) */
  exclude?: string;
  /** Trailing text for each row (dates, counts) */
  meta?: (doc: T) => ComponentChildren;
  empty?: string;
  /** Rendered-row index highlighted as the keyboard cursor (usePageListNavigation) */
  cursor?: number;
}) {
  const shown = exclude === undefined ? docs : docs.filter((d) => d.key !== exclude);
  if (shown.length === 0) return <p class="empty">{empty}</p>;

  return (
    <ul class={className}>
      {shown.map((d, i) => (
        <li key={d.key} class={i === cursor ? "kbd-cursor" : undefined}>
          <Link href={docHref(d.key)}>
            <DocTitle doc={d} />
          </Link>
          {meta && <span class="doc-link-meta">{meta(d)}</span>}
        </li>
      ))}
    </ul>
  );
}
