import { Link } from "wouter-preact";
import { type DocMeta, fetchDocs, fetchStats } from "../api";
import { useBucket } from "../bucket";
import { formatBytes, formatDate, formatPercent } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div class="stat-card">
      <span class="stat-value">{value}</span>
      <span class="stat-label">{label}</span>
    </div>
  );
}

function DocLinkList({
  docs,
  loading,
  meta,
}: {
  docs: DocMeta[] | undefined;
  loading: boolean;
  meta: (d: DocMeta) => string;
}) {
  if (loading) return <p class="empty">読み込み中…</p>;
  if (!docs || docs.length === 0) return <p class="empty">なし</p>;
  return (
    <ul class="doc-links">
      {docs.map((d) => (
        <li key={d.key}>
          <Link href={`/docs/${encodeURIComponent(d.key)}`}>{d.title}</Link>
          <span class="doc-link-meta">{meta(d)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Home() {
  useDocumentTitle(null);
  const { bucket } = useBucket();
  const stats = useAsync(fetchStats, []);
  const recent = useAsync(() => fetchDocs({ bucket, sort: "updated", per: 10 }), [bucket]);
  const popular = useAsync(() => fetchDocs({ bucket, sort: "accessed", per: 10 }), [bucket]);
  const stale = useAsync(
    () => fetchDocs({ bucket, stale: true, sort: "updated", per: 10 }),
    [bucket],
  );
  const s = stats.data;

  return (
    <div class="page">
      <h1>ホーム</h1>
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
      <div class="home-columns">
        <section class="home-section">
          <h2>最近更新</h2>
          <DocLinkList
            docs={recent.data?.docs}
            loading={recent.loading}
            meta={(d) => `${d.bucket} · ${formatDate(d.updated_at)}`}
          />
        </section>
        <section class="home-section">
          <h2>よく参照される</h2>
          <DocLinkList
            docs={popular.data?.docs}
            loading={popular.loading}
            meta={(d) => `${d.bucket} · 参照 ${d.access_count} 回`}
          />
        </section>
        <section class="home-section">
          <h2>
            陳腐化候補 <Link href="/docs?stale=1">すべて見る</Link>
          </h2>
          <DocLinkList
            docs={stale.data?.docs}
            loading={stale.loading}
            meta={(d) => `${d.bucket} · 最終更新 ${formatDate(d.updated_at)}`}
          />
        </section>
      </div>
    </div>
  );
}
