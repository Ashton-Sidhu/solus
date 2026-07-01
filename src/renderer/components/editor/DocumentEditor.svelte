<script lang="ts">
  import { untrack } from "svelte";
  import { Editor, Extension, type AnyExtension } from "@tiptap/core";
  import { NodeSelection } from "@tiptap/pm/state";
  import { Slice, Fragment, type Node as PMNode } from "@tiptap/pm/model";
  import { dropPoint } from "@tiptap/pm/transform";
  import { CellSelection } from "@tiptap/pm/tables";
  import StarterKit from "@tiptap/starter-kit";
  import { Markdown, type MarkdownStorage } from "tiptap-markdown";
  import Placeholder from "@tiptap/extension-placeholder";
  import Typography from "@tiptap/extension-typography";
  import TaskList from "@tiptap/extension-task-list";
  import TaskItem from "@tiptap/extension-task-item";
  import Image from "@tiptap/extension-image";
  import {
    Table,
    TableRow,
    TableHeader,
    TableCell,
  } from "@tiptap/extension-table";
  import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
  import GlobalDragHandle from "tiptap-extension-global-drag-handle";
  import { lowlight } from "./lowlight";
  import { SearchExtension } from "./searchExtension";
  import { imageFilesFromDataTransfer, readAsDataUrl } from "./images";
  import {
    SlashCommandExtension,
    filterCommands,
    executeSlashCommand,
    type EditorBlockCommand,
  } from "./slashCommands";
  import EditorSlashMenu from "./EditorSlashMenu.svelte";
  import EditorLinkPopover from "./EditorLinkPopover.svelte";
  import TableContextMenu from "./TableContextMenu.svelte";

  interface Props {
    value: string;
    /** Debounced, fired off the keystroke hot path with serialized markdown. */
    onValueChange: (md: string) => void;
    /** Cheap synchronous signal on every edit — lets the host mark dirty now. */
    onInput?: () => void;
    placeholder?: string;
    readOnly?: boolean;
    extraExtensions?: AnyExtension[];
    onEditorReady?: (editor: Editor) => void;
    onModeChange?: (mode: "rich" | "raw") => void;
    /** Forwarded keydown for an autocomplete host. Return true to consume the
     *  key (a reference menu handled it) so ProseMirror doesn't also act on it. */
    onKeyDown?: (e: KeyboardEvent) => boolean;
    onPlanRefClick?: (planId: string) => void;
    onWorkRefClick?: (workId: string, title?: string) => void;
    onFileRefClick?: (path: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    class?: string;
    style?: string;
    /** Whether the hover-to-grab block drag handle is mounted. Off for surfaces
     *  like the task description where reordering blocks isn't wanted. */
    dragHandle?: boolean;
  }

  let {
    value,
    onValueChange,
    onInput,
    placeholder = "",
    readOnly = false,
    extraExtensions = [],
    onEditorReady,
    onModeChange,
    onKeyDown,
    onPlanRefClick,
    onWorkRefClick,
    onFileRefClick,
    onFocus,
    onBlur,
    class: klass = "",
    style = "",
    dragHandle = true,
  }: Props = $props();

  // Matches a URL pasted onto a selection (smart-paste → link).
  const URL_RE = /^(https?:\/\/|mailto:)[^\s]+$/i;
  // How long to wait after the last keystroke before serializing to markdown.
  const EMIT_DEBOUNCE_MS = 350;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;

  let wrapperEl: HTMLDivElement | null = $state(null);
  let editorDiv: HTMLDivElement | null = $state(null);
  let editorInstance: Editor | null = $state(null);
  // Source table captured at dragstart so the drop can remove the whole node
  // (not just empty its cells). Plain let — never read in markup, no reactivity.
  let draggedTable: { pos: number; node: PMNode } | null = null;
  let mode = $state<"rich" | "raw">("rich");
  let rawTextareaEl: HTMLTextAreaElement | null = $state(null);
  // Skip the value-sync diff pass when the incoming `value` is our own echo.
  let lastEmittedMd = "";

  let slashActive = $state(false);
  let slashQuery = $state("");
  let slashFrom = $state(0);
  let slashTo = $state(0);
  let slashIndex = $state(0);
  let slashCoords = $state<{
    left: number;
    top: number;
    bottom: number;
  } | null>(null);
  let slashDismissed = $state(false);

  let tableMenuCoords = $state<{ x: number; y: number } | null>(null);
  let linkPopover = $state<{
    coords: { left: number; top: number; bottom: number };
    from: number;
    to: number;
    initialHref: string;
  } | null>(null);

  const slashFiltered = $derived(filterCommands(slashQuery));

  function getMd(editor: Editor): string {
    return (
      editor.storage as unknown as { markdown: MarkdownStorage }
    ).markdown.getMarkdown();
  }

  $effect(() => {
    if (!editorDiv) return;

    const ph = untrack(() => placeholder);
    const exts = untrack(() => extraExtensions);
    const onChange = untrack(() => onValueChange);
    const initialValue = untrack(() => value);
    const initialEditable = untrack(() => !readOnly);
    const dragEnabled = untrack(() => dragHandle);

    const editor = new Editor({
      element: editorDiv,
      extensions: [
        StarterKit.configure({
          codeBlock: false,
          hardBreak: false,
          trailingNode: false,
          undoRedo: { depth: 100 },
          link: { openOnClick: false, autolink: true },
          // Drop indicator shown while dragging a block — accent-tinted, thicker
          // and rounded (styled via .solus-dropcursor) so the landing spot reads
          // clearly instead of the default 1px black line.
          dropcursor: {
            width: 2,
            color: "var(--solus-accent)",
            class: "solus-dropcursor",
          },
        }),
        // transformPastedText parses pasted markdown into rich blocks (smart paste).
        Markdown.configure({
          html: true,
          tightLists: true,
          breaks: false,
          transformPastedText: true,
        }),
        CodeBlockLowlight.configure({ lowlight }),
        // Whole-doc placeholder when empty, otherwise a "/" command hint on the
        // current empty line so the slash menu is discoverable.
        Placeholder.configure({
          includeChildren: false,
          placeholder: ({ editor: e, node }) => {
            if (e.isEmpty) return ph;
            return node.type.name === "paragraph"
              ? "Type ‘/’ for commands…"
              : "";
          },
        }),
        // Smart quotes disabled — they surprise people writing technical prose
        // (paths, code-ish snippets, JSON). Dashes/ellipsis/arrows stay on.
        Typography.configure({
          openDoubleQuote: false,
          closeDoubleQuote: false,
          openSingleQuote: false,
          closeSingleQuote: false,
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Image.configure({ allowBase64: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        SlashCommandExtension,
        SearchExtension,
        ...(dragEnabled
          ? [
              GlobalDragHandle.configure({
                dragHandleWidth: 18,
                scrollTreshold: 100,
              }),
            ]
          : []),
        Extension.create({
          name: "customShortcuts",
          addKeyboardShortcuts() {
            return {
              "Alt-Shift-s": () =>
                this.editor.chain().focus().toggleStrike().run(),
              "Alt-Shift-k": () => {
                handleLink();
                return true;
              },
            };
          },
        }),
        ...exts,
      ],
      content: initialValue || "",
      editable: initialEditable,
      editorProps: {
        handlePaste: (view, event) => {
          // 1) Image files → embed inline as a data URL.
          const images = imageFilesFromDataTransfer(event.clipboardData);
          if (images.length > 0) {
            void insertImageFiles(images);
            return true;
          }
          // 2) A bare URL pasted over a non-empty selection → wrap as a link.
          const text = event.clipboardData?.getData("text/plain")?.trim();
          if (text && URL_RE.test(text) && !view.state.selection.empty) {
            editor.chain().focus().setLink({ href: text }).run();
            return true;
          }
          // 3) Otherwise let tiptap-markdown's transformPastedText handle it.
          return false;
        },
        handleDrop: (view, event, _slice, moved) => {
          const dragEvent = event as DragEvent;
          const images = imageFilesFromDataTransfer(dragEvent.dataTransfer);
          if (images.length > 0) {
            const coords = view.posAtCoords({
              left: dragEvent.clientX,
              top: dragEvent.clientY,
            });
            event.preventDefault();
            void insertImageFiles(images, coords?.pos);
            return true;
          }

          // Move a dragged table by removing the whole source node and
          // re-inserting it — PM's default would delete the live CellSelection,
          // which empties the cells but leaves the table behind (an empty husk).
          if (draggedTable && moved) {
            const dropPos = view.posAtCoords({
              left: dragEvent.clientX,
              top: dragEvent.clientY,
            });
            if (!dropPos) return false;
            const { pos: from, node } = draggedTable;
            const to = from + node.nodeSize;
            const slice = new Slice(Fragment.from(node), 0, 0);
            const insertPos = dropPoint(view.state.doc, dropPos.pos, slice) ?? dropPos.pos;
            event.preventDefault();
            // Dropped back inside its own range → nothing to move.
            if (insertPos >= from && insertPos <= to) return true;
            const tr = view.state.tr.delete(from, to);
            const mapped = tr.mapping.map(insertPos);
            tr.replaceRangeWith(mapped, mapped, node);
            if (NodeSelection.isSelectable(node)) {
              tr.setSelection(NodeSelection.create(tr.doc, mapped));
            }
            view.dispatch(tr.scrollIntoView());
            view.focus();
            return true;
          }
          return false;
        },
        handleKeyDown: (_view, event) => {
          // Let an autocomplete host intercept first (e.g. Enter to accept a
          // reference). It returns true when a menu consumed the key.
          return onKeyDown?.(event) ?? false;
        },
        handleClickOn: (_view, _pos, node, _nodePos, event) => {
          // Inline reference tokens open their target on plain click.
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
          // Cmd/Ctrl-click opens a link externally (links don't open on plain click).
          if (!(event.metaKey || event.ctrlKey)) return false;
          const href = editor.getAttributes("link").href as string | undefined;
          if (href) {
            void window.solus.openExternal(href);
            return true;
          }
          return false;
        },
      },
    });

    editor.on("transaction", () => {
      const isEditable = editor.isEditable;
      const selEmpty = editor.state.selection.empty;
      const isCode = editor.isActive("codeBlock");

      let newSlash: {
        query: string;
        from: number;
        to: number;
        coords: { left: number; top: number; bottom: number };
      } | null = null;

      if (isEditable && selEmpty && !isCode) {
        const head = editor.state.selection.$head;
        const blockText = head.parent.textBetween(
          0,
          head.parentOffset,
          undefined,
          "￼",
        );
        // Fast bail (P3): skip the regex + coordsAtPos unless a slash precedes
        // the cursor in this block. Trigger at line start OR after whitespace
        // so the menu works mid-line, not just at the very start of a block.
        if (blockText.includes("/")) {
          const match = blockText.match(/(?:^|\s)\/([a-zA-Z0-9]*)$/);
          if (match) {
            const leadingWs = match[0].length - match[0].replace(/^\s+/, "").length;
            const slashOffset = (match.index ?? 0) + leadingWs;
            const from = head.start() + slashOffset;
            const to = head.pos;
            const c = editor.view.coordsAtPos(from);
            newSlash = {
              query: match[1],
              from,
              to,
              coords: { left: c.left, top: c.top, bottom: c.bottom },
            };
          }
        }
      }

      queueMicrotask(() => {
        if (!isEditable || !selEmpty || isCode) {
          if (slashActive) slashActive = false;
          return;
        }

        if (newSlash) {
          const { query: newQuery, from, to, coords } = newSlash;
          if (newQuery !== slashQuery) {
            slashDismissed = false;
            slashIndex = 0;
          }
          if (!slashDismissed) {
            slashFrom = from;
            slashTo = to;
            slashQuery = newQuery;
            slashActive = true;
            slashCoords = coords;
          }
        } else {
          if (slashActive) slashActive = false;
          slashDismissed = false;
        }
      });
    });
    // P1: don't serialize the whole doc to markdown on every keystroke. Fire a
    // cheap synchronous signal so the host can mark itself dirty immediately,
    // and debounce the (expensive) markdown serialization off the hot path.
    editor.on("update", () => scheduleEmit(onChange));
    editor.on("focus", () => onFocus?.());
    editor.on("blur", () => onBlur?.());

    editor.storage.slashCommand.onArrowDown = () => {
      if (!slashActive) return false;
      const len = slashFiltered.length;
      if (len > 0) slashIndex = (slashIndex + 1) % len;
      return true;
    };
    editor.storage.slashCommand.onArrowUp = () => {
      if (!slashActive) return false;
      const len = slashFiltered.length;
      if (len > 0) slashIndex = (slashIndex - 1 + len) % len;
      return true;
    };
    editor.storage.slashCommand.onEnter = () => {
      if (!slashActive) return false;
      const filtered = slashFiltered;
      if (filtered.length > 0 && slashIndex < filtered.length) {
        handleSlashSelect(filtered[slashIndex]);
      }
      return true;
    };
    editor.storage.slashCommand.onEscape = () => {
      if (!slashActive) return false;
      slashActive = false;
      slashDismissed = true;
      return true;
    };

    editorInstance = editor;
    untrack(() => onEditorReady?.(editor));

    // The block-drag library hands the dragged node to the browser as the drag
    // image — Chromium paints that snapshot on a solid white card and leaves the
    // source block highlighted (node selection / text wash). Both read as heavy.
    // We swap in an empty off-screen element as the drag image (an Image() data
    // URL can lose the decode race and get ignored, so a real DOM node is used)
    // and flag the editor `is-dragging` so the selection wash is muted. Moving a
    // block then shows only the accent drop line gliding to its landing spot.
    // Skipped entirely when the drag handle is disabled.
    let dragGhost: HTMLDivElement | null = null;
    let onDocDragStart: ((e: DragEvent) => void) | null = null;
    let onDocDragEnd: (() => void) | null = null;
    if (dragEnabled) {
      const ghost = document.createElement("div");
      ghost.style.cssText =
        "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(ghost);
      dragGhost = ghost;
      onDocDragStart = (e: DragEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target?.closest(".drag-handle")) return;
        e.dataTransfer?.setDragImage(ghost, 0, 0);
        editorDiv?.classList.add("is-dragging");

        // Record the source table (if any) so handleDrop can move it deterministically.
        // tiptap-extension-global-drag-handle selects table cells, so PM's drop would
        // delete that CellSelection — which only empties the cells and leaves an empty
        // table husk behind. We instead remove the whole table node ourselves on drop.
        // (Our handler runs after the library's, which fires on the handle element.)
        const sel = editor.state.selection;
        if (sel instanceof CellSelection) {
          const tablePos = sel.$anchorCell.before(-1);
          draggedTable = { pos: tablePos, node: sel.$anchorCell.node(-1) };
        } else if (
          sel instanceof NodeSelection &&
          sel.node.type.name === "table"
        ) {
          draggedTable = { pos: sel.from, node: sel.node };
        } else {
          draggedTable = null;
        }
      };
      onDocDragEnd = () => {
        editorDiv?.classList.remove("is-dragging");
        draggedTable = null;
      };
      document.addEventListener("dragstart", onDocDragStart);
      document.addEventListener("dragend", onDocDragEnd);
    }

    return () => {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = null;
      if (onDocDragStart)
        document.removeEventListener("dragstart", onDocDragStart);
      if (onDocDragEnd) document.removeEventListener("dragend", onDocDragEnd);
      dragGhost?.remove();
      editor.destroy();
      editorInstance = null;
    };
  });

  async function insertImageFiles(files: File[], pos?: number) {
    if (!editorInstance) return;
    for (const file of files) {
      let src: string;
      try {
        src = await readAsDataUrl(file);
      } catch {
        continue;
      }
      if (!editorInstance) return;
      const chain = editorInstance.chain().focus();
      if (pos != null) {
        chain.insertContentAt(pos, {
          type: "image",
          attrs: { src, alt: file.name },
        });
      } else {
        chain.setImage({ src, alt: file.name });
      }
      chain.run();
    }
  }

  // Mode-aware current markdown: the rich doc serialized, or the raw textarea's
  // text verbatim (raw edits aren't mirrored into the rich doc until a switch).
  function currentMarkdown(): string {
    if (mode === "raw") return rawTextareaEl?.value ?? lastEmittedMd;
    return editorInstance ? getMd(editorInstance) : lastEmittedMd;
  }

  // P1 emit: cheap synchronous dirty signal + debounced markdown serialization.
  function scheduleEmit(emit: (md: string) => void) {
    onInput?.();
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      emitTimer = null;
      const md = currentMarkdown();
      lastEmittedMd = md;
      emit(md);
    }, EMIT_DEBOUNCE_MS);
  }

  export function cancelPendingEmit() {
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
  }

  // Synchronously emit the latest markdown if a debounced emit is pending. Used
  // before a mode switch so the surface we're revealing reads current content
  // through the `value` round-trip rather than a stale snapshot.
  function flushPendingEmit() {
    if (!emitTimer) return;
    clearTimeout(emitTimer);
    emitTimer = null;
    const md = currentMarkdown();
    lastEmittedMd = md;
    onValueChange(md);
  }

  export function getCurrentMarkdown(): string {
    return currentMarkdown();
  }

  // Mirror external value resets (e.g. cancel discards editBuffer) and raw-mode edits
  // back into the Tiptap editor — but only when the rich editor is visible. Re-parsing
  // markdown into a ProseMirror doc on every keystroke from the raw textarea would be
  // wasteful, so we skip the sync in raw mode and reconcile on the next switch back.
  $effect(() => {
    const ext = value;
    const m = mode;
    if (!editorInstance || m !== "rich") return;
    if (ext === lastEmittedMd) return;
    // P4: compare on normalized whitespace so a benign re-serialization diff
    // (trailing spaces, list-marker normalization) never triggers a full
    // setContent — which would reset the cursor + undo stack while the user is
    // mid-type. Only genuine content changes reconcile.
    const cur = getMd(editorInstance);
    if (normalizeMd(cur) !== normalizeMd(ext)) {
      editorInstance.commands.setContent(ext || "", { emitUpdate: false });
    }
  });

  function normalizeMd(s: string): string {
    return s.replace(/\s+/g, " ").trim();
  }

  // emitUpdate=false: toggling editability must never fire a content "update"
  // (Tiptap defaults it to true). A spurious update marks the doc dirty, which
  // triggers a save whose content round-trip re-runs this effect — an infinite
  // save loop that pins the status on "Saving…".
  $effect(() => {
    editorInstance?.setEditable(!readOnly, false);
  });

  export function focus() {
    if (mode === "raw") rawTextareaEl?.focus();
    else editorInstance?.commands.focus();
  }

  export function getEditor(): Editor | null {
    return editorInstance;
  }

  // Cursor rect (wrapper horizontal bounds + caret vertical position) used to
  // anchor reference-autocomplete menus. Null in raw mode (no rich autocomplete).
  export function getCursorRect(): DOMRect | null {
    if (mode === "raw") return null;
    const wrapperRect = wrapperEl?.getBoundingClientRect() ?? null;
    if (!editorInstance || !wrapperRect) return wrapperRect;
    const { from } = editorInstance.state.selection;
    const coords = editorInstance.view.coordsAtPos(from);
    return new DOMRect(
      wrapperRect.left,
      coords.top,
      wrapperRect.width,
      coords.bottom - coords.top,
    );
  }

  function handleRawInput() {
    // Debounced + mode-aware (currentMarkdown reads the textarea in raw mode).
    scheduleEmit(onValueChange);
  }

  export function toggleMode() {
    // Push current content into `value` so the surface we switch to reads it.
    flushPendingEmit();
    mode = mode === "rich" ? "raw" : "rich";
    onModeChange?.(mode);
    queueMicrotask(() => {
      if (mode === "raw") {
        rawTextareaEl?.focus({ preventScroll: true });
        rawTextareaEl?.setSelectionRange(0, 0);
      } else {
        editorInstance?.commands.focus("start", { scrollIntoView: false });
      }
    });
  }

  export function getMode(): "rich" | "raw" {
    return mode;
  }

  function handleLink() {
    if (!editorInstance) return;
    if (editorInstance.isActive("link") && editorInstance.state.selection.empty) {
      editorInstance.chain().focus().unsetLink().run();
      return;
    }
    const { from, to } = editorInstance.state.selection;
    const c = editorInstance.view.coordsAtPos(from);
    linkPopover = {
      coords: { left: c.left, top: c.top, bottom: c.bottom },
      from,
      to,
      initialHref: editorInstance.isActive("link")
        ? (editorInstance.getAttributes("link").href ?? "")
        : "",
    };
  }

  export function openLinkPopover() {
    handleLink();
  }

  function applyLink(href: string) {
    if (!editorInstance || !linkPopover) return;
    const { from, to } = linkPopover;
    editorInstance
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .setLink({ href })
      .run();
    linkPopover = null;
    editorInstance.commands.focus();
  }

  function closeLinkPopover() {
    linkPopover = null;
    editorInstance?.commands.focus();
  }

  function handleSlashSelect(cmd: EditorBlockCommand) {
    if (!editorInstance) return;
    executeSlashCommand(editorInstance, cmd, slashFrom, slashTo);
  }

  function handleContextMenu(e: MouseEvent) {
    if (!editorInstance) return;
    const target = e.target as HTMLElement;
    if (target.closest("td, th")) {
      e.preventDefault();
      tableMenuCoords = { x: e.clientX, y: e.clientY };
    }
  }
</script>

<div bind:this={wrapperEl} class="solus-doc-editor-wrap {klass}" {style} oncontextmenu={handleContextMenu} role="presentation">
  <div
    bind:this={editorDiv}
    class="solus-doc-editor"
    class:doc-mode-hidden={mode === "raw"}
  ></div>

  <textarea
    bind:this={rawTextareaEl}
    {value}
    oninput={handleRawInput}
    onfocus={() => onFocus?.()}
    onblur={() => onBlur?.()}
    readonly={readOnly}
    spellcheck="true"
    autocapitalize="off"
    autocorrect="on"
    class="solus-doc-raw"
    class:doc-mode-hidden={mode === "rich"}
    {placeholder}
  ></textarea>

  {#if slashActive && slashFiltered.length > 0 && slashCoords}
    <EditorSlashMenu
      commands={slashFiltered}
      selectedIndex={slashIndex}
      onSelect={handleSlashSelect}
      onHover={(i) => {
        slashIndex = i;
      }}
      anchorCoords={slashCoords}
    />
  {/if}

  {#if tableMenuCoords && editorInstance}
    <TableContextMenu
      editor={editorInstance}
      coords={tableMenuCoords}
      onClose={() => (tableMenuCoords = null)}
    />
  {/if}

  {#if linkPopover}
    <EditorLinkPopover
      anchorCoords={linkPopover.coords}
      initialHref={linkPopover.initialHref}
      onSubmit={applyLink}
      onCancel={closeLinkPopover}
    />
  {/if}
</div>

<style>
  /* Pasted/dropped images — sit inline as block figures, rounded + outlined to
     match the app's image treatment (warm hairline, never a hard black edge). */
  :global(.solus-doc-editor .ProseMirror img) {
    max-width: 100%;
    height: auto;
    border-radius: 0.5rem;
    border: 0.0625rem solid var(--solus-art-border, var(--solus-container-border));
    margin: 0.25rem 0;
  }
  :global(.solus-doc-editor .ProseMirror img.ProseMirror-selectednode) {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  /* Find & replace highlights (search decorations live inside .ProseMirror). */
  :global(.solus-doc-editor .ProseMirror .search-match) {
    background: color-mix(in srgb, var(--solus-art-2, #e6a23c) 38%, transparent);
    border-radius: 0.125rem;
  }
  :global(.solus-doc-editor .ProseMirror .search-match--current) {
    background: color-mix(in srgb, var(--solus-accent) 45%, transparent);
    box-shadow: 0 0 0 0.0625rem var(--solus-accent);
  }

  /* Column resize handles for resizable tables. */
  :global(.solus-doc-editor .ProseMirror .column-resize-handle) {
    position: absolute;
    right: -0.0625rem;
    top: 0;
    bottom: -0.0625rem;
    width: 0.1875rem;
    background: var(--solus-accent);
    opacity: 0;
    transition: opacity var(--duration-quick) var(--ease-premium);
    pointer-events: none;
  }
  :global(.solus-doc-editor .ProseMirror.resize-cursor) {
    cursor: col-resize;
  }
  :global(.solus-doc-editor .ProseMirror table:hover .column-resize-handle) {
    opacity: 0.5;
  }

  /* Drop indicator while dragging a block. prosemirror-dropcursor sets the
     accent fill inline (the `color` option); we add rounded ends + a soft accent
     glow so the landing spot reads as a deliberate, premium marker. */
  :global(.solus-dropcursor) {
    border-radius: 9999px;
    opacity: 0.7;
  }

  /* While a block is in flight, mute the source highlight — the selection wash
     and the node-selection outline — so the only thing the eye follows is the
     drop line, not a lit-up block left behind. */
  :global(.solus-doc-editor.is-dragging .ProseMirror ::selection) {
    background: transparent;
  }
  :global(.solus-doc-editor.is-dragging .ProseMirror ::-moz-selection) {
    background: transparent;
  }
  :global(.solus-doc-editor.is-dragging .ProseMirror *) {
    caret-color: transparent;
  }
  :global(.solus-doc-editor.is-dragging .ProseMirror-selectednode),
  :global(.solus-doc-editor.is-dragging .ProseMirror .selectedCell) {
    outline: none;
    background: transparent;
  }

  /* Global block drag handle (tiptap-extension-global-drag-handle mounts a
     single element on document.body — must be styled globally + unscoped).
     The element is the hover pill; the six-dot grip lives on ::before as a
     mask so it can be tinted independently (tertiary → accent on grab). */
  :global(.drag-handle) {
    position: fixed;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.5rem;
    z-index: 50;
    cursor: grab;
    border-radius: 0.3125rem;
    background-color: transparent;
    transition:
      background-color var(--duration-quick) var(--ease-premium),
      transform var(--duration-quick) var(--ease-premium);
  }
  :global(.drag-handle::before) {
    content: "";
    width: 0.875rem;
    height: 0.875rem;
    background-color: var(--solus-text-tertiary);
    opacity: 0.7;
    /* Six-dot grip as a mask so the dots inherit background-color. */
    --drag-grip: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='5.5' cy='3.5' r='1.3'/%3E%3Ccircle cx='10.5' cy='3.5' r='1.3'/%3E%3Ccircle cx='5.5' cy='8' r='1.3'/%3E%3Ccircle cx='10.5' cy='8' r='1.3'/%3E%3Ccircle cx='5.5' cy='12.5' r='1.3'/%3E%3Ccircle cx='10.5' cy='12.5' r='1.3'/%3E%3C/svg%3E");
    -webkit-mask: var(--drag-grip) center / contain no-repeat;
    mask: var(--drag-grip) center / contain no-repeat;
    transition:
      background-color var(--duration-quick) var(--ease-premium),
      opacity var(--duration-quick) var(--ease-premium);
  }
  :global(.drag-handle:hover) {
    background-color: var(--solus-surface-hover);
  }
  :global(.drag-handle:hover::before) {
    opacity: 1;
  }
  /* Grab: a quiet, tactile press — the pill settles into the hover surface and
     eases in slightly. No accent flood; picking a block up should feel like
     lifting it, not selecting it. */
  :global(.drag-handle:active) {
    cursor: grabbing;
    transform: scale(0.94);
    background-color: var(--solus-surface-hover);
  }
  :global(.drag-handle:active::before) {
    background-color: var(--solus-text-secondary);
    opacity: 1;
  }
  :global(.drag-handle.hide) {
    display: none;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.solus-doc-editor .ProseMirror .column-resize-handle),
    :global(.drag-handle),
    :global(.drag-handle::before) {
      transition: none !important;
    }
    :global(.drag-handle:active) {
      transform: none;
    }
  }
</style>
