import { Pencil } from "lucide-preact";
import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";
import { DocContent } from "../components/DocContent";
import type { WikiResolver } from "../markdown";
import { caretOffset, placeCaret, renderInlineTo } from "./dom";
import { type Block, type InlineNode, rawText } from "./model";
import { serializeMarkdown } from "./serialize";

export interface RichHandlers {
  onInput: (el: HTMLElement) => void;
  onKeyDown: (e: KeyboardEvent, el: HTMLElement) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (el: HTMLElement) => void;
  onPaste: (e: ClipboardEvent) => void;
}

/**
 * One contenteditable per block (Notion-style), never one big editable region: the browser
 * cannot then invent or destroy block structure, and an IME composition stays inside a
 * single block.
 *
 * Two rules keep the caret alive while typing:
 *
 * 1. **Every block is a `<div>`**, with the heading / quote look carried by a class. Turning a
 *    paragraph into a heading must not swap the DOM node — a swap blurs the element, and the
 *    keystrokes that arrive before focus is restored are simply lost.
 * 2. **The DOM is re-rendered only when `nonce` changes** — i.e. when the model moved behind
 *    the DOM's back (undo, toolbar, autoformat, structural edits). Typing does not re-render;
 *    the DOM is already right and the model follows it.
 */
export function RichBlock({
  inline,
  variant,
  label,
  nonce,
  editable,
  placeholder,
  marker,
  indent,
  handlers,
  registry,
  regKey,
}: {
  inline: InlineNode[];
  variant: string;
  label: string;
  nonce: number;
  editable: boolean;
  placeholder?: string;
  /** List bullet or number, drawn by CSS so it stays out of the editable text */
  marker?: string;
  indent?: number;
  handlers: RichHandlers;
  registry: Map<string, HTMLElement>;
  regKey: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const setRef = useCallback((el: HTMLElement | null) => {
    ref.current = el;
  }, []);

  // `inline` is read here but is deliberately NOT a dependency (rule 2 above): re-rendering
  // the text nodes on every keystroke drops characters out from under the caret.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    registry.set(regKey, el);
    const caret = document.activeElement === el ? caretOffset(el) : null;
    renderInlineTo(el, inline);
    if (caret !== null) placeCaret(el, caret);
  }, [nonce, regKey, registry]);

  useLayoutEffect(() => () => registry.delete(regKey), [regKey, registry]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a rich block cannot be an <input> or <textarea>
    <div
      class={`editor-block ${variant}`}
      data-placeholder={placeholder}
      data-marker={marker}
      style={indent === undefined ? undefined : { marginLeft: `${indent * 1.3}rem` }}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      tabIndex={editable ? 0 : undefined}
      contentEditable={editable}
      ref={setRef}
      onInput={(e) => handlers.onInput(e.currentTarget as HTMLElement)}
      onKeyDown={(e) => handlers.onKeyDown(e as unknown as KeyboardEvent, e.currentTarget)}
      onCompositionStart={handlers.onCompositionStart}
      onCompositionEnd={(e) => handlers.onCompositionEnd(e.currentTarget as HTMLElement)}
      onPaste={(e) => handlers.onPaste(e as unknown as ClipboardEvent)}
    />
  );
}

/**
 * Code, tables and raw HTML are edited as text and shown as a preview otherwise — a WYSIWYG
 * surface for them would have to reinvent a table editor and a syntax highlighter, and the
 * preview is what keeps mermaid and highlighted code readable on this screen.
 */
export function RawBlock({
  block,
  resolve,
  onChange,
  editable,
}: {
  block: Block;
  resolve: WikiResolver;
  onChange: (text: string) => void;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const value = rawText(block);

  if (!editable || !editing) {
    return (
      <div class="editor-raw">
        <DocContent
          content={serializeMarkdown([block])}
          contentType={block.type === "html" ? "html" : "markdown"}
          resolve={resolve}
        />
        {editable && (
          <button
            type="button"
            class="icon-btn editor-raw-edit"
            aria-label="このブロックを編集"
            title="このブロックを編集"
            onClick={() => setEditing(true)}
          >
            <Pencil size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div class="editor-raw editing">
      <textarea
        class="editor-raw-input"
        value={value}
        rows={Math.max(value.split("\n").length + 1, 3)}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          // Escape = the 完了 button: back to the rendered preview
          if (e.key === "Escape" && !e.isComposing) setEditing(false);
        }}
      />
      <button type="button" class="btn editor-raw-done" onClick={() => setEditing(false)}>
        完了
      </button>
    </div>
  );
}
