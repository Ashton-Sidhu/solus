<script lang="ts">
  import { untrack } from "svelte";
  import { Editor, Extension } from "@tiptap/core";
  import { Link } from "@tiptap/extension-link";
  import { TextSelection } from "@tiptap/pm/state";
  import StarterKit from "@tiptap/starter-kit";
  import { Markdown } from "@tiptap/markdown";
  import { referenceExtensions } from "./editor/referenceExtensions";

  interface Props {
    value: string;
    /** Debounced markdown — fired off the keystroke hot path. Flushed
     *  synchronously on Enter keydown, blur, and unmount so hosts that read
     *  `value` at send/submit time always see current content. */
    onValueChange: (md: string) => void;
    /** Cheap synchronous per-edit signal (autocomplete triggers, dirty marks). */
    onInput?: () => void;
    onKeyDown?: (e: KeyboardEvent) => void;
    /** When true, plain Enter inserts a newline instead of being swallowed for a
     *  send action. Used by editors with no "send" (e.g. the automation prompt). */
    enterInsertsNewline?: boolean;
    onPaste?: (e: ClipboardEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onPlanRefClick?: (planId: string) => void;
    onWorkRefClick?: (workId: string, title?: string) => void;
    onFileRefClick?: (path: string) => void;
    placeholder?: string;
    /** Hide the placeholder as soon as the editor is focused, rather than
     *  keeping it until the first character is typed. */
    hidePlaceholderOnFocus?: boolean;
    disabled?: boolean;
    maxHeight?: number;
    class?: string;
    style?: string;
  }

  let {
    value,
    onValueChange,
    onInput,
    onKeyDown,
    enterInsertsNewline = false,
    onPaste,
    onFocus,
    onBlur,
    onPlanRefClick,
    onWorkRefClick,
    onFileRefClick,
    placeholder = "",
    hidePlaceholderOnFocus = false,
    disabled = false,
    maxHeight = 140,
    class: klass = "",
    style = "",
  }: Props = $props();

  let wrapperDiv: HTMLDivElement | null = $state(null);
  let editorDiv: HTMLDivElement | null = $state(null);
  let editorInstance: Editor | null = $state.raw(null);
  let lastEmittedValue: string | null = null;
  let editorEmpty = $state(true);
  let focused = $state(false);
  // How long to wait after the last keystroke before serializing to markdown.
  // Serialization walks the whole doc, so it stays off the keystroke hot path;
  // Enter/blur/unmount flush synchronously so send paths never read stale text.
  const EMIT_DEBOUNCE_MS = 200;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;

  function emitNow() {
    if (!editorInstance) return;
    const md = getMarkdown(editorInstance);
    if (md === lastEmittedValue) return;
    lastEmittedValue = md;
    untrack(() => onValueChange(md));
  }

  function scheduleEmit() {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      emitTimer = null;
      emitNow();
    }, EMIT_DEBOUNCE_MS);
  }

  function flushPendingEmit() {
    if (!emitTimer) return;
    clearTimeout(emitTimer);
    emitTimer = null;
    emitNow();
  }

  // Drop (don't emit) a pending serialization — used when external content is
  // about to replace the doc. Flushing here would be wrong: by the time the
  // `value` sync runs, the host's write target may have moved (e.g. the input
  // bar's per-tab draft after a tab switch).
  function cancelPendingEmit() {
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
  }

  const ShiftEnter = Extension.create({
    name: "shiftEnter",
    addKeyboardShortcuts() {
      return {
        // Each command no-ops (returns false) when it doesn't apply, so
        // `first` falls through: newline inside code blocks, split list
        // items inside lists, otherwise split the block.
        "Shift-Enter": () =>
          this.editor.commands.first(({ commands }) => [
            () => commands.newlineInCode(),
            () => commands.splitListItem("listItem"),
            () => commands.splitBlock(),
          ]),
      };
    },
  });

  // When cursor is at the start of an empty paragraph inside a blockquote,
  // Backspace should exit the blockquote (lift the block) rather than
  // merge with the previous line.
  const BlockquoteBackspace = Extension.create({
    name: "blockquoteBackspace",
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Backspace: () => {
          if (!this.editor.isActive("blockquote")) return false;
          // liftEmptyBlock self-guards: it no-ops unless the cursor sits
          // collapsed in an empty block, so no manual emptiness checks.
          return this.editor.commands.liftEmptyBlock();
        },
      };
    },
  });

  const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };
  const ENTITY_RE = /&(?:amp|lt|gt|quot|#39);/g;
  const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
  const NonInclusiveLink = Link.extend({
    inclusive() {
      return false;
    },
  });

  function getMarkdown(editor: Editor): string {
    return unescapeProse(editor.getMarkdown());
  }

  // The serializer entity-encodes & < > in prose (symmetric with its parser),
  // but the emitted markdown is sent to the agent as literal prompt text, so
  // decode entities outside code segments.
  function unescapeProse(md: string): string {
    return md
      .split(CODE_SEGMENT_RE)
      .map((seg, i) =>
        i % 2 === 1 ? seg : seg.replace(ENTITY_RE, (m) => ENTITIES[m]),
      )
      .join("");
  }

  function shouldShowPlaceholder(editor: Editor): boolean {
    const doc = editor.state.doc;
    if (doc.childCount !== 1) return false;

    const onlyChild = doc.firstChild;
    return onlyChild?.type.name === "paragraph" && onlyChild.content.size === 0;
  }

  $effect(() => {
    if (!editorDiv) return;

    const editor = new Editor({
      element: editorDiv,
      extensions: [
        StarterKit.configure({
          hardBreak: false,
          link: false,
          trailingNode: false,
          undoRedo: { depth: 100 },
        }),
        NonInclusiveLink.configure({ openOnClick: false, autolink: true }),
        ShiftEnter,
        BlockquoteBackspace,
        ...referenceExtensions,
        Markdown,
      ],
      content: untrack(() => value) || "",
      contentType: "markdown",
      editable: untrack(() => !disabled),
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": untrack(() => placeholder) || "Message input",
          autocorrect: "off",
          autocapitalize: "off",
          autocomplete: "off",
        },
        handleTextInput(view, from, _to, text) {
          if (text !== "`") return false;

          const { state } = view;
          const head = state.selection.$head;
          const lineStart = head.start();
          const textBefore = state.doc.textBetween(lineStart, from);

          if (textBefore === "``") {
            editor
              .chain()
              .deleteRange({ from: lineStart, to: from })
              .setNode("codeBlock")
              .run();
            return true;
          }

          const backtickIdx = textBefore.lastIndexOf("`");
          if (backtickIdx >= 0) {
            const content = textBefore.slice(backtickIdx + 1);
            const charBefore =
              backtickIdx > 0 ? textBefore[backtickIdx - 1] : "";
            if (
              content.length > 0 &&
              (backtickIdx === 0 || /\s/.test(charBefore))
            ) {
              const absoluteStart = lineStart + backtickIdx;
              const { tr, schema } = state;
              const codeMark = schema.marks.code;
              if (codeMark) {
                tr.delete(absoluteStart, from);
                tr.insert(
                  absoluteStart,
                  schema.text(content, [codeMark.create()]),
                );
                tr.setStoredMarks([]);
                view.dispatch(tr);
                return true;
              }
            }
          }

          return false;
        },
        handleKeyDown(_view, event) {
          if (event.defaultPrevented) return true;
          // Send handlers read content through the `value` round-trip; flush
          // the debounced emit first so Enter never submits stale text.
          if (event.key === "Enter") flushPendingEmit();
          onKeyDown?.(event);
          // An autocomplete menu may have consumed it (e.g. Enter to accept).
          if (event.defaultPrevented) return true;
          if (event.key === "Enter" && !event.shiftKey)
            // Swallow plain Enter for send-on-Enter editors; let ProseMirror
            // split the block (newline) where Enter has no send semantics.
            return !enterInsertsNewline;
          return false;
        },
        handleClickOn(_view, _pos, node, _nodePos, event) {
          if (node.type.name === "planReference") {
            event.preventDefault();
            onPlanRefClick?.(node.attrs.planId);
            return true;
          }
          if (node.type.name === "workReference") {
            event.preventDefault();
            onWorkRefClick?.(node.attrs.workId, node.attrs.title);
            return true;
          }
          if (node.type.name === "fileReference") {
            event.preventDefault();
            onFileRefClick?.(node.attrs.path);
            return true;
          }
          return false;
        },
        handlePaste(view, event) {
          const items = event.clipboardData?.items;
          if (items) {
            for (const item of Array.from(items)) {
              if (item.type.startsWith("image/")) {
                onPaste?.(event);
                return true;
              }
            }
          }
          const text = event.clipboardData?.getData("text/plain");
          if (text) {
            event.preventDefault();
            view.dispatch(view.state.tr.insertText(text));
            return true;
          }
          return false;
        },
      },
    });

    editor.on("focus", () => {
      focused = true;
      onFocus?.();
    });
    editor.on("blur", () => {
      focused = false;
      flushPendingEmit();
      onBlur?.();
    });
    editor.on("update", () => {
      editorEmpty = shouldShowPlaceholder(editor);
      untrack(() => onInput?.());
      scheduleEmit();
    });

    editorInstance = editor;

    return () => {
      // Push any pending content to the host before teardown (e.g. a modal
      // closing right after the last keystroke).
      flushPendingEmit();
      editor.destroy();
      editorInstance = null;
    };
  });

  $effect(() => {
    const externalValue = value;
    if (!editorInstance) return;
    // Fast path: parent echo of our own emit, with no external setContent
    // since then. Tab switches still take the slow path because setContent
    // disarms lastEmittedValue below.
    if (lastEmittedValue !== null && externalValue === lastEmittedValue) return;

    const current = getMarkdown(editorInstance);
    if (current !== externalValue) {
      cancelPendingEmit();
      editorInstance.commands.setContent(externalValue || "", {
        emitUpdate: false,
        contentType: "markdown",
      });
      editorEmpty = shouldShowPlaceholder(editorInstance);
    }
    lastEmittedValue = null;
  });

  $effect(() => {
    editorInstance?.setEditable(!disabled);
  });

  // commands.focus() can miss after a display:none → visible transition;
  // hit the DOM directly first, then let Tiptap sync its selection state.
  export function focus() {
    if (!editorInstance) return;
    const dom = editorInstance.view.dom as HTMLElement;
    dom.focus({ preventScroll: true });
    editorInstance.commands.focus("end");
  }

  export function getCursorRect(): DOMRect | null {
    const wrapperRect = wrapperDiv?.getBoundingClientRect() ?? null;
    if (!editorInstance || !wrapperRect) return wrapperRect;
    const { from } = editorInstance.state.selection;
    const coords = editorInstance.view.coordsAtPos(from);
    // Use wrapper horizontal bounds so menus span the input bar width;
    // use cursor vertical position so menus appear above the cursor line.
    return new DOMRect(
      wrapperRect.left,
      coords.top,
      wrapperRect.width,
      coords.bottom - coords.top,
    );
  }

  export function getEditor(): Editor | null {
    return editorInstance;
  }

  export function setValueAndCursor(
    text: string,
    autoFocus = true,
    ensureTrailingParagraph = false,
  ) {
    if (!editorInstance) return;
    cancelPendingEmit();
    lastEmittedValue = null;
    editorInstance.commands.setContent(text || "", {
      emitUpdate: false,
      contentType: "markdown",
    });
    if (
      ensureTrailingParagraph &&
      editorInstance.state.doc.lastChild?.type.name === "blockquote"
    ) {
      const { state, view } = editorInstance;
      const insertAt = state.doc.content.size;
      const paragraph = state.schema.nodes.paragraph.create();
      const tr = state.tr.insert(insertAt, paragraph);
      tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
      view.dispatch(tr);
    }
    editorEmpty = shouldShowPlaceholder(editorInstance);
    if (autoFocus) editorInstance.commands.focus("end");
  }

  export function clearEditor() {
    if (!editorInstance) return;
    cancelPendingEmit();
    lastEmittedValue = null;
    editorInstance.commands.setContent("", { emitUpdate: false });
    editorEmpty = true;
  }

</script>

<div
  bind:this={wrapperDiv}
  data-testid="message-input"
  class="solus-md-editor-wrap relative w-full min-w-0 {klass}"
  style="--md-max-h:{maxHeight}px; {style}"
>
  <div bind:this={editorDiv} class="solus-md-editor"></div>
  {#if editorEmpty && !(hidePlaceholderOnFocus && focused)}
    <div class="solus-md-placeholder" aria-hidden="true">{placeholder}</div>
  {/if}
</div>
