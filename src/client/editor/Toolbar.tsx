import { Bold, Code, Italic, Link2, Strikethrough } from "lucide-preact";

export interface ToolbarPos {
  top: number;
  left: number;
}

/**
 * Selection toolbar for inline marks. Bold / italic / strike go through execCommand: the
 * browser edits the DOM and moves the caret, and the model is re-read from the DOM by the
 * usual input handler — one source of truth, no caret math.
 */
export function Toolbar({ pos, onCommand }: { pos: ToolbarPos; onCommand: (c: string) => void }) {
  const button = (command: string, label: string, icon: preact.JSX.Element) => (
    <button
      type="button"
      class="editor-tool"
      title={label}
      aria-label={label}
      // Keep the selection: mousedown would blur the contenteditable first
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onCommand(command)}
    >
      {icon}
    </button>
  );

  return (
    <div class="editor-toolbar" style={{ top: `${pos.top}px`, left: `${pos.left}px` }}>
      {button("bold", "太字", <Bold size={14} />)}
      {button("italic", "斜体", <Italic size={14} />)}
      {button("strike", "打ち消し", <Strikethrough size={14} />)}
      {button("code", "コード", <Code size={14} />)}
      {button("link", "リンク", <Link2 size={14} />)}
    </div>
  );
}
