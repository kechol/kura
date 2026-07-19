import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

interface Props {
  /** Trigger content while not editing (JSX allows a muted placeholder) */
  display: ComponentChildren;
  /** Initial input text when editing starts */
  value: string;
  placeholder?: string;
  /** Tooltip on the trigger button */
  title: string;
  /** datalist id to attach to the input */
  list?: string;
  /** Extra elements rendered inside the form (e.g. the datalist) */
  children?: ComponentChildren;
  /** Caller owns persistence and error state; called on submit and blur */
  onSave: (raw: string) => void | Promise<void>;
  /** Called when editing is cancelled with Escape */
  onCancel?: () => void;
  error?: string | null;
}

/**
 * Click-to-edit meta field (document path, aliases — docs: browser-ui.md).
 * Owns only the editing state; the caller saves, reloads, and reports errors.
 * Escape restores the original value before the closing blur fires, so the
 * blur-save becomes a no-op for callers that skip unchanged values.
 */
export function InlineEditField({
  display,
  value,
  placeholder,
  title,
  list,
  children,
  onSave,
  onCancel,
  error,
}: Props) {
  const [edit, setEdit] = useState<string | null>(null);
  const save = (raw: string) => {
    setEdit(null);
    void onSave(raw);
  };
  return (
    <>
      {edit === null ? (
        <button
          type="button"
          class="path-edit-trigger"
          title={title}
          onClick={() => setEdit(value)}
        >
          {display}
        </button>
      ) : (
        <form
          class="path-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            save(edit);
          }}
        >
          <input
            type="text"
            list={list}
            placeholder={placeholder}
            value={edit}
            // biome-ignore lint/a11y/noAutofocus: the field only exists once the user asks for it
            autoFocus
            onInput={(e) => setEdit((e.target as HTMLInputElement).value)}
            onBlur={(e) => save((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                (e.currentTarget as HTMLInputElement).value = value;
                setEdit(null);
                onCancel?.();
              }
            }}
          />
          {children}
        </form>
      )}
      {error != null && <p class="error">{error}</p>}
    </>
  );
}
