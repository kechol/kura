import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { htmlToMarkdownService } from "../../core/clip/turndown";
import type { WikiResolver } from "../markdown";
import { RawBlock, RichBlock, type RichHandlers } from "./blocks";
import { caretOffset, placeCaret, readInline, splitInline } from "./dom";
import {
  type Block,
  blockId,
  type HeadingLevel,
  type InlineNode,
  inlineOf,
  inlineText,
  isRawBlock,
  type ListItem,
  listItem,
  normalizeInline,
  withInline,
  withRawText,
} from "./model";
import { parseMarkdown } from "./parse";
import { listOrdinals, serializeMarkdown } from "./serialize";
import { Toolbar, type ToolbarPos } from "./Toolbar";

const AUTOSAVE_MS = 1500;
const UNDO_COALESCE_MS = 500;
const UNDO_LIMIT = 100;

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

/** A rich editing target: a block, or one item of a list block */
type EditKey = string;

const keyOf = (id: string, item?: number): EditKey => (item === undefined ? id : `${id}#${item}`);
const parseKey = (key: EditKey): { id: string; item: number | null } => {
  const [id, item] = key.split("#");
  return { id: id ?? "", item: item === undefined ? null : Number(item) };
};

const turndown = htmlToMarkdownService();

/** Bullet or ordinal drawn next to a list item, numbered exactly as the serializer will */
function markers(items: ListItem[]): string[] {
  const ordinals = listOrdinals(items);
  return items.map((item, i) => (item.ordered ? `${ordinals[i]}.` : "•"));
}

export function Editor({
  initial,
  resolve,
  onSave,
  editable = true,
  onStatus,
}: {
  initial: string;
  resolve: WikiResolver;
  onSave: (markdown: string) => Promise<void>;
  editable?: boolean;
  onStatus?: (status: SaveStatus) => void;
}) {
  const [blocks, setBlocks] = useState<Block[]>(() => parseMarkdown(initial));
  // Bumped only when the model changed behind the DOM's back — typing must not re-render
  const [nonce, setNonce] = useState(0);
  const [toolbar, setToolbar] = useState<ToolbarPos | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const elements = useRef<Map<EditKey, HTMLElement>>(new Map());
  const composing = useRef(false);
  const pendingFocus = useRef<{ key: EditKey; offset: number } | null>(null);
  const undoStack = useRef<Block[][]>([]);
  const redoStack = useRef<Block[][]>([]);
  const lastUndoPush = useRef(0);

  const markdown = useMemo(() => serializeMarkdown(blocks), [blocks]);
  // Lazily, once: useRef evaluates its argument on every render, and re-parsing the whole
  // document per keystroke is the most expensive thing this component could do
  const saved = useRef<string | null>(null);
  if (saved.current === null) saved.current = markdown;

  // Status is the parent's to render, not ours — keeping a copy here would re-render the
  // whole editor on every save transition
  const setStatus = useCallback((status: SaveStatus) => onStatus?.(status), [onStatus]);

  // ---- model updates -------------------------------------------------------

  /** The one place the model is written, so undo depth and coalescing have a single home */
  const commit = useCallback(
    (
      update: Block[] | ((prev: Block[]) => Block[]),
      opts: {
        rerender?: boolean;
        focus?: { key: EditKey; offset: number };
        coalesce?: boolean;
      } = {},
    ) => {
      const now = Date.now();
      const push = !opts.coalesce || now - lastUndoPush.current > UNDO_COALESCE_MS;
      if (push) {
        redoStack.current = [];
        lastUndoPush.current = now;
      }
      // The snapshot is taken from the state the update is applied to, never from a closure
      // — during fast typing a captured `blocks` can already be a version nobody saw
      setBlocks((prev) => {
        if (push) {
          undoStack.current.push(prev);
          if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
        }
        return typeof update === "function" ? update(prev) : update;
      });
      if (opts.rerender !== false) setNonce((n) => n + 1);
      if (opts.focus) pendingFocus.current = opts.focus;
      setStatus("dirty");
    },
    [setStatus],
  );

  const replaceInline = useCallback(
    (list: Block[], key: EditKey, inline: InlineNode[]): Block[] => {
      const { id, item } = parseKey(key);
      return list.map((b) => {
        if (b.id !== id) return b;
        if (item !== null && b.type === "list") {
          const items = b.items.map((it, i) => (i === item ? { ...it, inline } : it));
          return { ...b, items };
        }
        return withInline(b, inline);
      });
    },
    [],
  );

  // ---- typing --------------------------------------------------------------

  const autoformat = (key: EditKey, nodes: InlineNode[]): Block[] | null => {
    const { id, item } = parseKey(key);
    const block = blocks.find((b) => b.id === id);
    if (block?.type !== "paragraph" || item !== null) return null;

    // A trailing space typed into a contenteditable arrives as a non-breaking space in
    // Chrome and Safari; the markdown prefixes must still be recognised
    const plain = inlineText(nodes).replace(/\u00a0/g, " ");
    const heading = /^(#{1,6}) /.exec(plain);
    const bullet = /^[-*+] /.exec(plain);
    const ordered = /^\d+\. /.exec(plain);
    const quote = /^> /.exec(plain);
    const fence = /^```(\S*)$/.exec(plain);

    const rest = (prefixLength: number): InlineNode[] => splitInline(nodes, prefixLength)[1];

    let next: Block | null = null;
    if (heading) {
      const level = Math.min(heading[1]?.length ?? 1, 6) as HeadingLevel;
      next = { id: block.id, type: "heading", level, inline: rest(heading[0].length) };
    } else if (bullet || ordered) {
      const prefix = (bullet ?? ordered)?.[0] ?? "";
      next = {
        id: block.id,
        type: "list",
        items: [listItem(rest(prefix.length), 0, ordered !== null)],
      };
    } else if (quote) {
      next = { id: block.id, type: "blockquote", inline: rest(quote[0].length) };
    } else if (fence) {
      next = { id: block.id, type: "code", lang: fence[1] ?? "", text: "" };
    }
    if (next === null) return null;

    const list = blocks.map((b) => (b.id === block.id ? (next as Block) : b));
    // The caret lands at the start of what is left after the marker. A list item is addressed
    // as an item, and a code block takes focus through its own textarea, so it asks for none.
    pendingFocus.current =
      next.type === "code"
        ? null
        : { key: next.type === "list" ? keyOf(block.id, 0) : keyOf(block.id), offset: 0 };
    return list;
  };

  const syncFromDom = useCallback(
    (key: EditKey, el: HTMLElement) => {
      const nodes = readInline(el);
      const formatted = autoformat(key, nodes);
      if (formatted !== null) {
        commit(formatted);
        return;
      }
      // Typing: update the model but leave the DOM alone (no nonce bump), coalescing undo
      commit((prev) => replaceInline(prev, key, nodes), { rerender: false, coalesce: true });
    },
    [autoformat, commit, replaceInline],
  );

  // ---- structural editing --------------------------------------------------

  /** Rewrite one list block's items in place */
  const withItems = (
    id: string,
    items: ListItem[],
    focus: { key: EditKey; offset: number },
  ): void => {
    commit(
      blocks.map((b) => (b.id === id ? { ...b, items } : b)),
      { focus },
    );
  };

  /**
   * One item leaves the list and becomes a paragraph: the list splits around it (Enter on an
   * empty top-level item, and Backspace at the start of one, are the same move).
   */
  const leaveList = (
    index: number,
    block: Block & { type: "list" },
    item: number,
    inline: InlineNode[],
  ): void => {
    const head = block.items.slice(0, item);
    const tail = block.items.slice(item + 1);
    const fresh: Block = { id: blockId(), type: "paragraph", inline };
    commit(
      [
        ...blocks.slice(0, index),
        ...(head.length > 0 ? [{ ...block, items: head }] : []),
        fresh,
        ...(tail.length > 0 ? [{ id: blockId(), type: "list" as const, items: tail }] : []),
        ...blocks.slice(index + 1),
      ],
      { focus: { key: keyOf(fresh.id), offset: 0 } },
    );
  };

  const onEnter = (key: EditKey, el: HTMLElement): boolean => {
    const { id, item } = parseKey(key);
    const index = blocks.findIndex((b) => b.id === id);
    const block = blocks[index];
    if (!block) return false;
    const offset = caretOffset(el) ?? 0;
    const [before, after] = splitInline(readInline(el), offset);

    if (item !== null && block.type === "list") {
      const current = block.items[item];
      if (!current) return false;

      // Enter on an empty item: outdent, or leave the list
      if (inlineText(current.inline) === "") {
        if (current.depth > 0) return onIndent(key, -1);
        leaveList(index, block, item, []);
        return true;
      }

      const items = [...block.items];
      items[item] = { ...current, inline: before };
      items.splice(item + 1, 0, listItem(after, current.depth, current.ordered));
      withItems(id, items, { key: keyOf(id, item + 1), offset: 0 });
      return true;
    }

    if (inlineOf(block) === null) return false;

    const head = withInline(block, before);
    const tail: Block =
      block.type === "blockquote"
        ? { id: blockId(), type: "blockquote", inline: after }
        : { id: blockId(), type: "paragraph", inline: after };
    commit([...blocks.slice(0, index), head, tail, ...blocks.slice(index + 1)], {
      focus: { key: keyOf(tail.id), offset: 0 },
    });
    return true;
  };

  const onBackspaceAtStart = (key: EditKey): boolean => {
    const { id, item } = parseKey(key);
    const index = blocks.findIndex((b) => b.id === id);
    const block = blocks[index];
    if (!block) return false;

    if (item !== null && block.type === "list") {
      const current = block.items[item];
      if (!current) return false;
      if (current.depth > 0) return onIndent(key, -1);
      // Depth 0: the item leaves the list and becomes a paragraph
      leaveList(index, block, item, current.inline);
      return true;
    }

    // A heading or quote first becomes a plain paragraph
    if (block.type === "heading" || block.type === "blockquote") {
      commit(
        blocks.map((b) =>
          b.id === id ? { id: b.id, type: "paragraph", inline: inlineOf(block) ?? [] } : b,
        ),
        { focus: { key: keyOf(id), offset: 0 } },
      );
      return true;
    }

    const prev = blocks[index - 1];
    if (block.type !== "paragraph" || !prev) return false;
    const prevInline = inlineOf(prev);
    if (prevInline === null) return false;

    const merged = normalizeInline([...prevInline, ...block.inline]);
    commit([...blocks.slice(0, index - 1), withInline(prev, merged), ...blocks.slice(index + 1)], {
      focus: { key: keyOf(prev.id), offset: inlineText(prevInline).length },
    });
    return true;
  };

  const onIndent = (key: EditKey, delta: number): boolean => {
    const { id, item } = parseKey(key);
    const block = blocks.find((b) => b.id === id);
    if (item === null || block?.type !== "list") return false;
    const current = block.items[item];
    if (!current) return false;

    const previous = block.items[item - 1];
    const maxDepth = previous ? previous.depth + 1 : 0;
    const depth = Math.min(Math.max(current.depth + delta, 0), maxDepth);
    if (depth === current.depth) return false;

    const caret = elements.current.get(key);
    withItems(
      id,
      block.items.map((it, i) => (i === item ? { ...it, depth } : it)),
      {
        key,
        offset: (caret && caretOffset(caret)) || 0,
      },
    );
    return true;
  };

  /** Undo and redo move a snapshot between the stacks; they must not push a new one */
  const timeTravel = (from: typeof undoStack, to: typeof redoStack) => {
    const snapshot = from.current.pop();
    if (!snapshot) return;
    setBlocks((prev) => {
      to.current.push(prev);
      return snapshot;
    });
    setNonce((n) => n + 1);
    setStatus("dirty");
  };

  const save = useCallback(async () => {
    if (markdown === saved.current) return;
    const pending = markdown;
    setStatus("saving");
    try {
      await onSave(pending);
      saved.current = pending;
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [markdown, onSave, setStatus]);

  // ---- keyboard ------------------------------------------------------------

  const onKeyDown = (key: EditKey, e: KeyboardEvent, el: HTMLElement) => {
    if (e.isComposing || e.keyCode === 229) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) timeTravel(redoStack, undoStack);
      else timeTravel(undoStack, redoStack);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (onEnter(key, el)) e.preventDefault();
      return;
    }
    if (e.key === "Tab") {
      if (onIndent(key, e.shiftKey ? -1 : 1)) e.preventDefault();
      return;
    }
    if (e.key === "Backspace") {
      const offset = caretOffset(el);
      const selection = window.getSelection();
      if (offset === 0 && selection?.isCollapsed === true && onBackspaceAtStart(key)) {
        e.preventDefault();
      }
    }
  };

  // ---- paste ---------------------------------------------------------------

  const onPaste = (key: EditKey, e: ClipboardEvent) => {
    const html = e.clipboardData?.getData("text/html") ?? "";
    const plain = e.clipboardData?.getData("text/plain") ?? "";
    const md = html !== "" ? turndown.turndown(html) : plain;
    if (md.trim() === "") return;

    e.preventDefault();
    // A single line stays inline; anything with structure becomes blocks
    if (!md.includes("\n")) {
      document.execCommand("insertText", false, md);
      return;
    }
    const { id } = parseKey(key);
    const index = blocks.findIndex((b) => b.id === id);
    const pasted = parseMarkdown(md);
    const last = pasted[pasted.length - 1];
    const next = [...blocks.slice(0, index + 1), ...pasted, ...blocks.slice(index + 1)];
    commit(next, last ? { focus: { key: keyOf(last.id), offset: 0 } } : {});
  };

  // ---- selection toolbar ---------------------------------------------------

  useEffect(() => {
    if (!editable) return;
    document.execCommand("styleWithCSS", false, "false");
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const container = root.current;
      if (
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        !container ||
        !container.contains(selection.anchorNode)
      ) {
        setToolbar(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const base = container.getBoundingClientRect();
      setToolbar({ top: rect.top - base.top - 40, left: rect.left - base.left });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [editable]);

  const activeKey = (): EditKey | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    for (const [key, el] of elements.current) {
      if (el.contains(selection.anchorNode)) return key;
    }
    return null;
  };

  const onCommand = (command: string) => {
    const key = activeKey();
    if (key === null) return;
    const el = elements.current.get(key);
    if (!el) return;

    if (command === "bold") document.execCommand("bold");
    else if (command === "italic") document.execCommand("italic");
    else if (command === "strike") document.execCommand("strikeThrough");
    else if (command === "code") {
      const selection = window.getSelection();
      const range = selection?.getRangeAt(0);
      if (range) {
        const code = document.createElement("code");
        code.appendChild(range.extractContents());
        range.insertNode(code);
      }
    } else if (command === "link") {
      const url = window.prompt("リンク先 URL");
      if (url === null || url === "") return;
      document.execCommand("createLink", false, url);
    }
    // The browser edited the DOM; the model is re-read from it
    commit(replaceInline(blocks, key, readInline(el)), { rerender: false });
    setToolbar(null);
  };

  // ---- focus / autosave ----------------------------------------------------

  // Layout effect, not a passive one: focus must be back before the next keystroke arrives,
  // or the characters typed in the gap go nowhere
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const el = elements.current.get(target.key);
    if (!el) return;
    el.focus();
    placeCaret(el, target.offset);
  });

  useEffect(() => {
    if (!editable || markdown === saved.current) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [markdown, editable, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (markdown !== saved.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [markdown]);

  // ---- render --------------------------------------------------------------

  const handlersFor = (key: EditKey): RichHandlers => ({
    onInput: (el) => {
      if (composing.current) return;
      syncFromDom(key, el);
    },
    onKeyDown: (e, el) => onKeyDown(key, e, el),
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (el) => {
      composing.current = false;
      syncFromDom(key, el);
    },
    onPaste: (e) => onPaste(key, e),
  });

  return (
    <div class="editor" ref={root}>
      {toolbar !== null && editable && <Toolbar pos={toolbar} onCommand={onCommand} />}
      {blocks.map((block) => {
        if (isRawBlock(block)) {
          return (
            <RawBlock
              key={block.id}
              block={block}
              resolve={resolve}
              editable={editable}
              onChange={(value) =>
                commit((prev) => prev.map((b) => (b.id === block.id ? withRawText(b, value) : b)), {
                  rerender: false,
                  coalesce: true,
                })
              }
            />
          );
        }

        if (block.type === "hr") return <hr key={block.id} />;

        if (block.type === "list") {
          const labels = markers(block.items);
          // No <ul> wrapper, and the first item reuses the block's Preact key on purpose:
          // turning a paragraph into a list then patches the same <div> instead of replacing
          // it, so the caret never leaves the element the user is typing into.
          return block.items.map((item, i) => {
            const key = keyOf(block.id, i);
            return (
              <RichBlock
                key={i === 0 ? block.id : key}
                variant="li"
                label="リスト項目"
                marker={labels[i]}
                indent={item.depth}
                inline={item.inline}
                nonce={nonce}
                editable={editable}
                handlers={handlersFor(key)}
                registry={elements.current}
                regKey={key}
              />
            );
          });
        }

        const key = keyOf(block.id);
        // The tag never changes (see RichBlock): a heading is a div that looks like one
        const variant =
          block.type === "heading"
            ? `h${block.level}`
            : block.type === "blockquote"
              ? "quote"
              : "para";
        const label =
          block.type === "heading"
            ? `見出し ${block.level}`
            : block.type === "blockquote"
              ? "引用"
              : "本文";
        return (
          <RichBlock
            key={block.id}
            variant={variant}
            label={label}
            inline={inlineOf(block) ?? []}
            nonce={nonce}
            editable={editable}
            placeholder={block.type === "paragraph" ? "本文を入力…" : undefined}
            handlers={handlersFor(key)}
            registry={elements.current}
            regKey={key}
          />
        );
      })}
    </div>
  );
}
