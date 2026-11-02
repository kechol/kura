import type { DocDetail } from "../api";
import { fetchDocs } from "../api";
import { useBucket } from "../bucket";
import { useAsync } from "../hooks";
import { DocLinkList } from "./DocLink";

const TAG_SECTIONS = 3;
const PER_SECTION = 6;
const SIBLINGS = 10;

/** Parent path of a document ("db/sqlite" → "db"); "" for a document at the bucket root */
function parentPath(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** Sidebar for the document being read: the documents that share a tag or sit in the same path */
export function DocContextSidebar({ doc }: { doc: DocDetail }) {
  const { bucket } = useBucket();
  const byTag = useAsync(
    () =>
      Promise.all(
        doc.tags
          .slice(0, TAG_SECTIONS)
          .map((tag) =>
            fetchDocs({ bucket, tag, per: PER_SECTION }).then((r) => ({ tag, docs: r.docs })),
          ),
      ),
    [doc.key, doc.tags.join(","), bucket],
  );
  const siblingPath = parentPath(doc.path);
  const siblings = useAsync(
    () => fetchDocs({ bucket, prefix: siblingPath || undefined, per: SIBLINGS }),
    [doc.key, siblingPath, bucket],
  );

  return (
    <>
      {(byTag.data ?? []).map(({ tag, docs }) => (
        <section class="sidebar-section" key={tag}>
          <h2>#{tag}</h2>
          <DocLinkList docs={docs} class="sidebar-docs" exclude={doc.key} />
        </section>
      ))}

      <section class="sidebar-section">
        <h2>{siblingPath === "" ? "同じ階層（直下）" : `同じ階層（${siblingPath}）`}</h2>
        <DocLinkList docs={siblings.data?.docs ?? []} class="sidebar-docs" exclude={doc.key} />
      </section>
    </>
  );
}
