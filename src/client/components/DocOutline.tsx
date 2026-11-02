import type { OutlineItem } from "../editor/model";

/** Below this there is nothing to navigate: one heading is just the document's own shape */
const MIN_HEADINGS = 2;

/** The document's headings as jump targets. The caller owns finding the heading on screen. */
export function DocOutline({
  headings,
  onJump,
}: {
  headings: OutlineItem[];
  onJump: (index: number) => void;
}) {
  if (headings.length < MIN_HEADINGS) return null;
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <nav class="side-box" aria-labelledby="doc-outline-heading">
      <h2 id="doc-outline-heading">目次</h2>
      <ol class="outline-list">
        {headings.map((h, i) => (
          <li key={i} style={{ paddingLeft: `${(h.level - top) * 0.8}rem` }}>
            <button type="button" class="outline-link" onClick={() => onJump(i)}>
              {h.text === "" ? "（空の見出し）" : h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
