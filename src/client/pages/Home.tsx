import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import {
  type DocMeta,
  fetchDocs,
  fetchInsights,
  fetchStale,
  fetchTags,
  type Insights,
  type StaleResult,
} from "../api";
import { useBucket } from "../bucket";
import { DocCardGrid } from "../components/DocCard";
import { DocLinkList, docHref } from "../components/DocLink";
import { formatDate, formatDateTime } from "../format";
import { type AsyncState, useAsync, useDocumentTitle, usePageListNavigation } from "../hooks";
import { useModal } from "../modal";

/** How many stale candidates the "放置気味" section lists (the nudge bar shows the full count) */
const STALE_LIMIT = 5;

/** How many cards each dashboard section shows */
const SECTION_SIZE = 6;

interface Loadable {
  loading: boolean;
  error: string | null;
}

/** One card-grid dashboard section (最近表示した, お気に入り, …) */
interface CardSection {
  title: string;
  moreHref: string;
  state: Loadable;
  docs: DocMeta[];
  meta: (doc: DocMeta) => string;
  empty: string;
}

/** A dashboard section: heading, a "すべて見る →" link, and one of loading / error / empty / body */
function HomeSection({
  title,
  moreHref,
  state,
  isEmpty,
  empty,
  children,
}: {
  title: string;
  moreHref?: string;
  state: Loadable;
  isEmpty: boolean;
  empty: string;
  children: ComponentChildren;
}) {
  return (
    <section class="home-section">
      <div class="home-section-head">
        <h2>{title}</h2>
        {moreHref !== undefined && (
          <Link class="home-section-more" href={moreHref}>
            すべて見る →
          </Link>
        )}
      </div>
      {state.error && <p class="error">{state.error}</p>}
      {state.loading && <p class="empty">読み込み中…</p>}
      {!state.loading && !state.error && isEmpty && <p class="empty">{empty}</p>}
      {!state.loading && !state.error && !isEmpty && children}
    </section>
  );
}

/** Data-hygiene chips. Hidden while insights/stale load, and when every count is zero. */
function NudgeBar({
  insights,
  stale,
}: {
  insights: AsyncState<Insights>;
  stale: AsyncState<StaleResult>;
}) {
  const i = insights.data;
  const s = stale.data;
  if (i === null || s === null) return null;
  const chips = [
    { label: "放置気味", count: s.count, href: "/docs?stale=1" },
    { label: "未整理", count: i.unfiled.count, href: "/stats" },
    { label: "タグなし", count: i.untagged.count, href: "/stats" },
    { label: "孤立", count: i.orphans.count, href: "/stats" },
    { label: "未解決リンク", count: i.brokenLinks.count, href: "/stats" },
    { label: "タグ重複", count: i.tagDuplicates.length, href: "/stats" },
  ].filter((c) => c.count > 0);
  if (chips.length === 0) return null;
  return (
    <div class="home-nudges">
      {chips.map((c) => (
        <Link key={c.label} class="home-nudge" href={c.href}>
          {c.label}
          <span class="home-nudge-count">{c.count}</span>
        </Link>
      ))}
    </div>
  );
}

/** タグ別ピックアップ: top-3 tags, each with its most-recently-updated documents. */
function TagPickup({
  state,
  groups,
  cursor,
  baseOffset,
}: {
  state: Loadable;
  groups: Array<{ tag: string; docs: DocMeta[] }> | null;
  cursor: number;
  baseOffset: number;
}) {
  return (
    <HomeSection
      title="タグ別ピックアップ"
      state={state}
      isEmpty={groups !== null && groups.length === 0}
      empty="まだタグがありません"
    >
      {groups?.map((g, gi) => {
        // Offset of this group inside the flattened keyboard cursor array
        const base = baseOffset + groups.slice(0, gi).reduce((n, prev) => n + prev.docs.length, 0);
        return (
          <div class="home-tag-group" key={g.tag}>
            <h3>
              <Link href={`/docs?tag=${encodeURIComponent(g.tag)}`}>#{g.tag}</Link>
            </h3>
            <DocCardGrid
              docs={g.docs}
              meta={(d) => `更新 ${formatDate(d.updated_at)}`}
              cursorIndex={cursor - base}
            />
          </div>
        );
      })}
    </HomeSection>
  );
}

/** Home = a multi-section dashboard. Statistics live on /stats; the reading history on Ctrl+R. */
export function Home() {
  useDocumentTitle(null);
  const [, navigate] = useLocation();
  const { bucket } = useBucket();
  const modal = useModal();

  // Each collection loads independently so a slow query never blocks the others.
  const insights = useAsync(() => fetchInsights(bucket), [bucket]);
  const stale = useAsync(() => fetchStale(bucket, STALE_LIMIT), [bucket]);
  const recent = useAsync(
    () => fetchDocs({ bucket, sort: "accessed", per: SECTION_SIZE, excerpt: true }),
    [bucket],
  );
  // Over-fetch 2× because the created !== updated filter below drops never-edited
  // docs; the headroom keeps the section full after filtering down to SECTION_SIZE.
  const updated = useAsync(
    () => fetchDocs({ bucket, sort: "updated", per: SECTION_SIZE * 2, excerpt: true }),
    [bucket],
  );
  const created = useAsync(
    () => fetchDocs({ bucket, sort: "created", per: SECTION_SIZE, excerpt: true }),
    [bucket],
  );
  const favorites = useAsync(
    () => fetchDocs({ bucket, favorite: true, sort: "title", per: SECTION_SIZE, excerpt: true }),
    [bucket],
  );
  const views = useAsync(
    () => fetchDocs({ bucket, sort: "views", per: SECTION_SIZE, excerpt: true }),
    [bucket],
  );
  const tagPickup = useAsync(async () => {
    const tags = await fetchTags(bucket);
    const top = [...tags].sort((a, b) => b.count - a.count).slice(0, 3);
    return Promise.all(
      top.map(async (t) => ({
        tag: t.path,
        docs: (await fetchDocs({ bucket, tag: t.path, sort: "updated", per: 4, excerpt: true }))
          .docs,
      })),
    );
  }, [bucket]);

  // Section doc lists (post-filter), each memoized on its source so identity is stable once loaded.
  const s1 = useMemo(
    () => (recent.data?.docs ?? []).filter((d) => d.last_accessed_at !== null),
    [recent.data],
  );
  const s2 = useMemo(
    () =>
      (updated.data?.docs ?? [])
        .filter((d) => d.created_at !== d.updated_at)
        .slice(0, SECTION_SIZE),
    [updated.data],
  );
  const s3 = useMemo(() => created.data?.docs ?? [], [created.data]);
  const s4 = useMemo(() => favorites.data?.docs ?? [], [favorites.data]);
  const s5 = useMemo(
    () => (views.data?.docs ?? []).filter((d) => d.access_count > 0),
    [views.data],
  );
  const s6 = useMemo(() => (tagPickup.data ?? []).flatMap((g) => g.docs), [tagPickup.data]);

  // The five card sections in render order. Each carries its async state,
  // post-filter docs, meta formatter, and empty text so the dashboard renders
  // with one map() and the keyboard offsets derive from this same array.
  const cardSections: CardSection[] = [
    {
      title: "最近表示した",
      moreHref: "/docs?sort=accessed",
      state: recent,
      docs: s1,
      meta: (d) => `${formatDateTime(d.last_accessed_at)} · 参照 ${d.access_count} 回`,
      empty: "まだ表示したドキュメントがありません",
    },
    {
      title: "最近更新された",
      moreHref: "/docs?sort=updated",
      state: updated,
      docs: s2,
      meta: (d) => `更新 ${formatDate(d.updated_at)}`,
      empty: "最近更新されたドキュメントはありません",
    },
    {
      title: "新しく作成された",
      moreHref: "/docs?sort=created",
      state: created,
      docs: s3,
      meta: (d) => `作成 ${formatDate(d.created_at)}`,
      empty: "新しく作成されたドキュメントはありません",
    },
    {
      title: "お気に入り",
      moreHref: "/docs?favorite=1",
      state: favorites,
      docs: s4,
      meta: (d) => `更新 ${formatDate(d.updated_at)}`,
      empty: "お気に入りはまだありません",
    },
    {
      title: "よく参照する",
      moreHref: "/docs?sort=views",
      state: views,
      docs: s5,
      meta: (d) => `参照 ${d.access_count} 回`,
      empty: "よく参照するドキュメントはまだありません",
    },
  ];

  // Give each card section its start index within the flat cursor array via a
  // running doc count; the tag-pickup groups (s6) follow, so their base is the
  // total card-doc count. This replaces the old hand-maintained off2..off6 sum.
  const cards: Array<{ section: CardSection; offset: number }> = [];
  let cardOffset = 0;
  for (const section of cardSections) {
    cards.push({ section, offset: cardOffset });
    cardOffset += section.docs.length;
  }
  const tagBaseOffset = cardOffset;

  // One keyboard cursor over every card in the order the offsets follow: the
  // card sections (s1..s5) then the tag-pickup groups (s6). Memoized on the same
  // slice sources so its identity — and the cursor position — stays stable.
  const flat = useMemo(() => [...s1, ...s2, ...s3, ...s4, ...s5, ...s6], [s1, s2, s3, s4, s5, s6]);

  const cursor = usePageListNavigation(flat, (d) => navigate(docHref(d.key)), {
    disabled: modal.isOpen,
  });

  // Empty-bucket gate: the updated query's total counts every document in the bucket.
  const bucketEmpty = updated.data !== null && updated.data.total === 0;

  return (
    <div class="page">
      <NudgeBar insights={insights} stale={stale} />

      {bucketEmpty ? (
        <p class="empty">
          このバケットにはまだドキュメントがありません。
          <Link href="/docs">ドキュメント一覧</Link>から始めてみてください。
        </p>
      ) : (
        <>
          {cards.map(({ section, offset }) => (
            <HomeSection
              key={section.title}
              title={section.title}
              moreHref={section.moreHref}
              state={section.state}
              isEmpty={section.docs.length === 0}
              empty={section.empty}
            >
              <DocCardGrid docs={section.docs} meta={section.meta} cursorIndex={cursor - offset} />
            </HomeSection>
          ))}

          <TagPickup
            state={tagPickup}
            groups={tagPickup.data}
            cursor={cursor}
            baseOffset={tagBaseOffset}
          />

          {stale.data !== null && stale.data.count > 0 && (
            <section class="home-section">
              <div class="home-section-head">
                <h2>放置気味</h2>
              </div>
              <p class="insight-hint">
                しばらく更新されていないドキュメントです。kura ls --stale で一覧を確認できます。
              </p>
              <DocLinkList
                docs={stale.data.docs}
                meta={(d) =>
                  `更新から ${d.daysSinceUpdate} 日 · 参照 ${d.accessCount} 回 · スコア ${d.staleScore.toFixed(1)}`
                }
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
