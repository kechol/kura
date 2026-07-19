import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { fetchInsights, fetchStats, type Insights } from "../api";
import { useBucket } from "../bucket";
import { DocLinkList, docHref } from "../components/DocLink";
import { formatBytes, formatPercent } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div class="stat-card">
      <span class="stat-value">{value}</span>
      <span class="stat-label">{label}</span>
    </div>
  );
}

/** The findings that are just a list of documents; the other two have their own shape */
const DOC_GROUPS: Array<{
  group: "unfiled" | "untagged" | "orphans";
  title: string;
  hint: string;
  empty: string;
}> = [
  {
    group: "unfiled",
    title: "未整理（Bucket 直下）",
    hint: "path が未設定のドキュメントです。kura triage で整理できます。",
    empty: "すべて path が設定されています。",
  },
  {
    group: "untagged",
    title: "タグなし",
    hint: "タグが 1 つも付いていません。kura triage で整理できます。",
    empty: "すべてのドキュメントにタグが付いています。",
  },
  {
    group: "orphans",
    title: "孤立（リンクなし）",
    hint: "どこからも参照されず、どこも参照していません。[[リンク]] で他のドキュメントと繋げてみてください。",
    empty: "孤立したドキュメントはありません。",
  },
];

/** A tidying finding: the count, the command that fixes it, and the list behind a toggle */
function InsightCard({
  title,
  count,
  hint,
  empty,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  empty: string;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section class="insight-card">
      <button
        type="button"
        class="insight-head"
        onClick={() => setOpen((o) => !o)}
        disabled={count === 0}
      >
        <span class="insight-title">{title}</span>
        <span class={`insight-count${count === 0 ? " zero" : ""}`}>{count}</span>
        {count > 0 && <span class="insight-toggle">{open ? "▾" : "▸"}</span>}
      </button>
      <p class="insight-hint">{count === 0 ? empty : hint}</p>
      {open && count > 0 && <div class="insight-body">{children}</div>}
    </section>
  );
}

export function StatsPage() {
  useDocumentTitle("統計");
  const { bucket } = useBucket();
  const stats = useAsync(fetchStats, []);
  const insights = useAsync(() => fetchInsights(bucket), [bucket]);
  const s = stats.data;
  const i: Insights | null = insights.data;

  return (
    <div class="page">
      <h1>統計</h1>
      {stats.error && <p class="error">{stats.error}</p>}
      {s && (
        <div class="stat-cards">
          <StatCard label="ドキュメント" value={s.documents} />
          <StatCard label="Bucket" value={s.buckets.length} />
          <StatCard label="タグ" value={s.tags} />
          <StatCard label="チャンク" value={s.chunks} />
          <StatCard label="embedding カバレッジ" value={formatPercent(s.embeddingCoverage)} />
          <StatCard label="陳腐化候補" value={s.staleDocuments} />
          <StatCard label="未解決リンク" value={s.unresolvedLinks} />
          <StatCard label="DB サイズ" value={formatBytes(s.dbSizeBytes)} />
          <StatCard label="トークナイザ" value={s.tokenizer} />
          <StatCard label="embedding モデル" value={s.embeddingModel ?? "未設定"} />
        </div>
      )}

      {s && s.buckets.length > 0 && (
        <section class="stats-section">
          <h2>Bucket 別</h2>
          <ul class="bucket-stats">
            {s.buckets.map((b) => (
              <li key={b.name}>
                <span>{b.name}</span>
                <span class="count">{b.documents}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="stats-section">
        <h2>整理のヒント（{bucket}）</h2>
        <p class="muted">
          修正は CLI で行います。ここは選択中の Bucket
          を対象に、放置されがちな箇所を数えるだけです。
        </p>
        {insights.error && <p class="error">{insights.error}</p>}
        {insights.loading && <p class="empty">集計中…</p>}
        {i && (
          <div class="insight-cards">
            {DOC_GROUPS.map((g) => (
              <InsightCard
                key={g.group}
                title={g.title}
                count={i[g.group].count}
                hint={g.hint}
                empty={g.empty}
              >
                <DocLinkList docs={i[g.group].docs} />
              </InsightCard>
            ))}

            <InsightCard
              title="未解決リンク"
              count={i.brokenLinks.count}
              hint="リンク先が存在しません。ドキュメントを作るか、リンクを直してください。"
              empty="未解決のリンクはありません。"
            >
              <ul class="broken-links">
                {i.brokenLinks.links.map((l) => (
                  <li key={l.targetTitle}>
                    <span class="broken-target">[[{l.targetTitle}]]</span>
                    <span class="broken-sources">
                      {l.sources.map((src) => (
                        <Link key={src.key} href={docHref(src.key)}>
                          {src.title}
                        </Link>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </InsightCard>

            <InsightCard
              title="タグの重複候補"
              count={i.tagDuplicates.length}
              hint="同じ意味のタグが表記ゆれしている可能性があります。kura audit tags で統合候補を確認できます。"
              empty="表記ゆれしたタグは見つかりませんでした。"
            >
              <ul class="tag-dupes">
                {i.tagDuplicates.map((t) => (
                  <li key={`${t.from}→${t.to}`}>
                    <code>{t.from}</code> → <code>{t.to}</code>
                    <span class="count">{t.reason}</span>
                  </li>
                ))}
              </ul>
            </InsightCard>
          </div>
        )}
      </section>
    </div>
  );
}
