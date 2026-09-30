<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { untrack } from "svelte";
  import { Editor, Extension, type AnyExtension } from "@tiptap/core";
  import { Markdown } from "@tiptap/markdown";
  import { Dropcursor, UndoRedo } from "@tiptap/extensions";
  import Collaboration from "@tiptap/extension-collaboration";
  import CollaborationCaret from "@tiptap/extension-collaboration-caret";
  import { DOCUMENT_LIVE_FIELD } from "@solus/contracts/work-live";
  import type { LiveEditorBinding } from "./lib/live-editor";
  import { createMarkdownParser } from "@solus/document-model/markdown";
  import type { DocumentBlockViews } from "@solus/document-model/schema";
  import { editorSchemaExtensions } from "./lib/editor-schema";
  import { assetImageResolver } from "./lib/document-image-view";
  import Placeholder from "@tiptap/extension-placeholder";
  import Typography from "@tiptap/extension-typography";
  import { CellFocus } from "./cellFocus";
  import DragHandle from "@tiptap/extension-drag-handle";
  import { SearchExtension } from "./searchExtension";
  import { readAsDataUrl } from "./images";
  import {
    assetFileMarkdown,
    attachmentFilesFromDataTransfer,
    isInlineAssetImage,
    uploadAsset,
  } from "../../lib/asset-upload";
  import { getMarkdownImageContext } from "../conversation/lib/markdown-image";
  import {
    SlashCommandExtension,
    filterCommands,
    executeSlashCommand,
    slashMenuIsOpen,
    askSolusCommand,
    embedArtifactCommand,
    embedDiagramCommand,
    type EditorBlockCommand,
  } from "./slashCommands";
  import EditorSlashMenu from "./EditorSlashMenu.svelte";
  import EditorLinkPopover from "./EditorLinkPopover.svelte";
  import EditorLinkPreview from "./EditorLinkPreview.svelte";
  import TableContextMenu from "./TableContextMenu.svelte";
  import TableChrome from "./TableChrome.svelte";
  import { TableFlow } from "./tableFlow";
  import EditorVoiceControl from "../input/EditorVoiceControl.svelte";
  import { dictationInsertion } from "../input/lib/dictation-text";

  const imageContext = getMarkdownImageContext();
  import { portal } from "../portal";
  import { installLiveTableResize } from "./lib/live-table-resize";
  import RawMarkdownEditor from "./RawMarkdownEditor.svelte";
  import WorkEmbedPicker from "./WorkEmbedPicker.svelte";
  import type { WorkEmbedChoice } from "./lib/work-embed";
  import { linkActivationAction } from "./lib/link-preview";

  interface Props {
    value: string;
    /** Debounced, fired off the keystroke hot path with serialized markdown. */
    onValueChange: (md: string) => void;
    /** Cheap synchronous signal on every edit — lets the host mark dirty now. */
    onInput?: () => void;
    placeholder?: string;
    readOnly?: boolean;
    /** Enable the voice shortcut on this surface. The idle mic stays hidden;
     *  hosts that want a visible mic mount their own control in the header. */
    dictation?: boolean;
    extraExtensions?: AnyExtension[];
    /** Node views for the blocks of a work or a plan. Given, the editor uses
     *  the full document schema; omitted, the markdown schema. Read once. */
    documentBlocks?: DocumentBlockViews;
    onEditorReady?: (editor: Editor) => void;
    onModeChange?: (mode: "rich" | "raw") => void;
    /** Forwarded keydown for an autocomplete host. Return true to consume the
     *  key (a reference menu handled it) so ProseMirror doesn't also act on it. */
    onKeyDown?: (e: KeyboardEvent) => boolean;
    onPlanRefClick?: (planId: string) => void;
    onWorkRefClick?: (workId: string, title?: string) => void;
    onPrRefClick?: (number: number, title?: string) => void;
    onFileRefClick?: (path: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    /** When set, the slash menu offers "Ask Solus to draft…". Surfaces without
     *  an agent behind them simply don't pass it. */
    onAskSolus?: () => void;
    diagramChoices?: WorkEmbedChoice[];
    artifactChoices?: WorkEmbedChoice[];
    class?: string;
    style?: string;
    /** Whether the hover-to-grab block drag handle is mounted. Off for surfaces
     *  like the task description where reordering blocks isn't wanted. */
    dragHandle?: boolean;
    /** A work edited live: the body is the shared doc, not `value`, and undo
     *  reverses only the reader's own edits. Read once, at mount. */
    live?: LiveEditorBinding | null;
  }

  let {
    value,
    onValueChange,
    onInput,
    placeholder = "",
    readOnly = false,
    dictation = false,
    extraExtensions = [],
    documentBlocks,
    onEditorReady,
    onModeChange,
    onKeyDown,
    onPlanRefClick,
    onWorkRefClick,
    onPrRefClick,
    onFileRefClick,
    onFocus,
    onBlur,
    onAskSolus,
    diagramChoices,
    artifactChoices,
    class: klass = "",
    style = "",
    dragHandle = true,
    live = null,
  }: Props = $props();

  // Live: the Markdown source is a view of the shared doc. Its edits go into
  // the doc as a structural change; the host's updates refresh it.
  const liveBinding = untrack(() => live);
  let liveRawValue = $state("");

  // Matches a URL pasted onto a selection (smart-paste → link).
  const URL_RE = /^(https?:\/\/|mailto:)[^\s]+$/i;
  // How long to wait after the last keystroke before serializing to markdown.
  const EMIT_DEBOUNCE_MS = 350;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;

  let wrapperEl: HTMLDivElement | null = $state(null);
  let editorDiv: HTMLDivElement | null = $state(null);
  let editorInstance: Editor | null = $state(null);
  let mode = $state<"rich" | "raw">("rich");
  let isFocused = $state(false);
  let rawEditorRef: RawMarkdownEditor | null = $state(null);
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

  // `axis` is set only when a grip opened the menu — right-click has no axis to
  // go on, so it gets the whole verb list.
  let tableMenuCoords = $state<{
    x: number;
    y: number;
    axis?: "row" | "column";
  } | null>(null);
  let linkPopover = $state<{
    coords: { left: number; top: number; bottom: number };
    from: number;
    to: number;
    initialHref: string;
  } | null>(null);
  let linkPreview = $state<{
    coords: { left: number; top: number; bottom: number };
    href: string;
    pos: number;
  } | null>(null);
  // Which member of the embed family the picker is choosing, or null when it
  // is closed. One picker, so the two can never be open at once.
  let embedPicker = $state<"diagram" | "artifact" | null>(null);

  const slashExtras = $derived([
    ...(diagramChoices ? [embedDiagramCommand(() => (embedPicker = "diagram"))] : []),
    ...(artifactChoices ? [embedArtifactCommand(() => (embedPicker = "artifact"))] : []),
    ...(onAskSolus ? [askSolusCommand(onAskSolus)] : []),
  ]);
  const slashFiltered = $derived(filterCommands(slashQuery, slashExtras));
  const slashMenuOpen = $derived(slashMenuIsOpen(slashActive, slashFiltered.length));

  $effect(() => {
    if (!editorDiv) return;

    const ph = untrack(() => placeholder);
    const exts = untrack(() => extraExtensions);
    const onChange = untrack(() => onValueChange);
    const initialValue = untrack(() => value);
    const initialEditable = untrack(() => !readOnly);
    const dragEnabled = untrack(() => dragHandle);
    const blocks = untrack(() => documentBlocks);

    const editor = new Editor({
      element: editorDiv,
      extensions: [
        ...editorSchemaExtensions(assetImageResolver(imageContext), blocks),
        // A live doc takes Collaboration's undo, which reverses only the
        // reader's own edits; the local history would undo a teammate's.
        ...(liveBinding
          ? [
              Collaboration.configure({ document: liveBinding.live.doc, field: DOCUMENT_LIVE_FIELD }),
              CollaborationCaret.configure({ provider: { awareness: liveBinding.live.awareness }, user: liveBinding.user }),
            ]
          : [UndoRedo.configure({ depth: 100 })]),
        // Drop indicator shown while dragging a block — accent-tinted, thicker
        // and rounded (styled via .solus-dropcursor) so the landing spot reads
        // clearly instead of the default 1px black line.
        Dropcursor.configure({
          width: 2,
          color: "var(--solus-accent)",
          class: "solus-dropcursor",
        }),
        Markdown.configure({ marked: createMarkdownParser() }),
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
        CellFocus,
        TableFlow,
        SlashCommandExtension,
        SearchExtension,
        // Hover-to-grab block drag handle. Defaults render a `.drag-handle`
        // element (styled below) positioned in the left gutter; dragging sets a
        // NodeRangeSelection over the hovered block, so whole nodes (including
        // tables) move correctly through ProseMirror's native drop handling.
        ...(dragEnabled ? [DragHandle] : []),
        Extension.create({
          name: "customShortcuts",
          addKeyboardShortcuts() {
            return {
              "Alt-Shift-s": () =>
                this.editor.chain().focus().toggleStrike().run(),
              "Alt-Shift-k": () => {
                openLinkPopover();
                return true;
              },
            };
          },
        }),
        ...exts,
      ],
      // A live editor takes its content from the shared doc.
      content: liveBinding ? undefined : initialValue || "",
      contentType: "markdown",
      editable: initialEditable,
      // Read-only text still needs focus for selection-based comments and copy.
      coreExtensionOptions: { tabindex: { value: "0" } },
      editorProps: {
        handlePaste: (view, event) => {
          // 1) Files → store images inline and other attachments as links.
          const files = attachmentFilesFromDataTransfer(event.clipboardData);
          if (files.length > 0) {
            void insertAssetFiles(files);
            return true;
          }
          // 2) A bare URL pasted over a non-empty selection → wrap as a link.
          const text = event.clipboardData?.getData("text/plain")?.trim();
          if (text && URL_RE.test(text) && !view.state.selection.empty) {
            editor.chain().focus().setLink({ href: text }).run();
            return true;
          }
          // 3) Plain-text paste → parse as markdown (smart paste). When the
          //    clipboard also carries text/html, keep ProseMirror's rich-HTML
          //    paste path instead.
          const raw = event.clipboardData?.getData("text/plain");
          const html = event.clipboardData?.getData("text/html");
          if (raw && !html) {
            editor.commands.insertContent(raw, { contentType: "markdown" });
            return true;
          }
          return false;
        },
        handleDrop: (view, event) => {
          const files = attachmentFilesFromDataTransfer(event.dataTransfer);
          if (files.length > 0) {
            const coords = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            event.preventDefault();
            void insertAssetFiles(files, coords?.pos);
            return true;
          }
          return false;
        },
        handleKeyDown: (_view, event) => {
          // Let an autocomplete host intercept first (e.g. Enter to accept a
          // reference). It returns true when a menu consumed the key.
          return onKeyDown?.(event) ?? false;
        },
        handleClickOn: (_view, pos, node, _nodePos, event) => {
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
          if (node.type.name === "prReference") {
            event.preventDefault();
            onPrRefClick?.(node.attrs.number, node.attrs.title);
            return true;
          }
          if (node.type.name === "fileReference") {
            event.preventDefault();
            onFileRefClick?.(node.attrs.path);
            return true;
          }
          const anchor = event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>("a[href]")
            : null;
          if (!anchor) return false;

          event.preventDefault();
          const href = anchor.getAttribute("href");
          if (!href) return false;
          if (linkActivationAction(event) === "open") {
            void localApi.openExternal(href);
            return true;
          }

          const rect = anchor.getBoundingClientRect();
          linkPreview = {
            coords: { left: rect.left, top: rect.top, bottom: rect.bottom },
            href,
            pos,
          };
          return true;
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
    editor.on("focus", () => announceFocus(true));
    editor.on("blur", () => announceFocus(false));

    // Every handler gates on the *menu*, not on the "/" token: a token that
    // matches nothing renders no menu, so Enter must still break the line.
    editor.storage.slashCommand.onArrowDown = () => {
      if (!slashMenuOpen) return false;
      slashIndex = (slashIndex + 1) % slashFiltered.length;
      return true;
    };
    editor.storage.slashCommand.onArrowUp = () => {
      if (!slashMenuOpen) return false;
      const len = slashFiltered.length;
      slashIndex = (slashIndex - 1 + len) % len;
      return true;
    };
    editor.storage.slashCommand.onEnter = () => {
      if (!slashMenuOpen) return false;
      const filtered = slashFiltered;
      if (slashIndex < filtered.length) handleSlashSelect(filtered[slashIndex]);
      return true;
    };
    editor.storage.slashCommand.onEscape = () => {
      if (!slashMenuOpen) return false;
      slashActive = false;
      slashDismissed = true;
      return true;
    };

    editorInstance = editor;
    untrack(() => onEditorReady?.(editor));
    const stopLiveTableResize = installLiveTableResize(editor);

    // The drag-handle extension hands the browser a snapshot of the dragged
    // node as the drag image — Chromium paints it on a solid white card, and
    // the source block stays highlighted (node selection / text wash). Both
    // read as heavy. We swap in an empty off-screen element as the drag image
    // (our document-level listener runs after the extension's element-level
    // one, so our setDragImage wins) and flag the editor `is-dragging` so the
    // selection wash is muted. Moving a block then shows only the accent drop
    // line gliding to its landing spot. Skipped when the handle is disabled.
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
        if (!(e.target instanceof Element) || !e.target.closest(".drag-handle")) return;
        e.dataTransfer?.setDragImage(ghost, 0, 0);
        editorDiv?.classList.add("is-dragging");
      };
      onDocDragEnd = () => {
        editorDiv?.classList.remove("is-dragging");
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
      stopLiveTableResize();
      editor.destroy();
      editorInstance = null;
    };
  });

  async function insertAssetFiles(files: File[], pos?: number) {
    if (!editorInstance) return;
    for (const file of files) {
      const isImage = isInlineAssetImage(file);
      let src: string;
      try {
        const api = imageContext?.api();
        if (api) {
          const asset = await uploadAsset(api, file);
          if (!isImage) {
            const markdown = assetFileMarkdown(file.name || "attachment", asset.uri);
            const chain = editorInstance.chain().focus();
            if (pos != null) chain.insertContentAt(pos, markdown, { contentType: "markdown" });
            else chain.insertContent(markdown, { contentType: "markdown" });
            chain.run();
            continue;
          }
          // The node keeps the stable reference; the image view signs it.
          src = asset.uri;
        } else if (isImage) {
          src = await readAsDataUrl(file);
        } else {
          continue;
        }
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

  // Both editors can emit focus while Svelte is mid-flush; defer the state
  // write so the host's handler never runs inside a template reaction.
  function announceFocus(focused: boolean) {
    queueMicrotask(() => {
      isFocused = focused;
      if (focused) onFocus?.();
      else onBlur?.();
    });
  }

  // Mode-aware current markdown: the rich doc serialized, or the source editor's
  // text verbatim (raw edits aren't mirrored into the rich doc until a switch).
  export function getCurrentMarkdown(): string {
    if (mode === "raw") return rawEditorRef?.getValue() ?? lastEmittedMd;
    return editorInstance ? editorInstance.getMarkdown() : lastEmittedMd;
  }

  // P1 emit: cheap synchronous dirty signal + debounced markdown serialization.
  function scheduleEmit(emit: (md: string) => void) {
    onInput?.();
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      emitTimer = null;
      const md = getCurrentMarkdown();
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
    const md = getCurrentMarkdown();
    lastEmittedMd = md;
    if (liveBinding && mode === "raw") applyRawToLive(md);
    else onValueChange(md);
  }

  // Mirror external value resets (e.g. cancel discards editBuffer) and raw-mode edits
  // back into the Tiptap editor — but only when the rich editor is visible. Re-parsing
  // markdown into a ProseMirror doc on every source edit would be
  // wasteful, so we skip the sync in raw mode and reconcile on the next switch back.
  $effect(() => {
    const ext = value;
    const m = mode;
    if (!editorInstance || m !== "rich" || liveBinding) return;
    if (ext === lastEmittedMd) return;
    // P4: compare on normalized whitespace so a benign re-serialization diff
    // (trailing spaces, list-marker normalization) never triggers a full
    // setContent — which would reset the cursor + undo stack while the user is
    // mid-type. Only genuine content changes reconcile.
    const cur = editorInstance.getMarkdown();
    if (normalizeMd(cur) !== normalizeMd(ext)) {
      editorInstance.commands.setContent(ext || "", {
        emitUpdate: false,
        contentType: "markdown",
      });
    }
  });

  /** Live: a Markdown edit becomes a structural change to the shared doc. */
  function applyRawToLive(md: string) {
    if (!editorInstance || md === editorInstance.getMarkdown()) return;
    editorInstance.commands.setContent(md, { contentType: "markdown" });
  }

  // A host update lands after the reader's pending Markdown edit, never under
  // it, so neither is lost; then the source shows the merged document.
  $effect(() => {
    if (!liveBinding) return;
    const target = liveBinding.live;
    target.beforeRemote = () => {
      if (mode === "raw" && emitTimer) flushPendingRaw();
    };
    target.afterRemote = () => {
      if (mode === "raw" && !emitTimer && editorInstance) liveRawValue = editorInstance.getMarkdown();
    };
    return () => {
      target.beforeRemote = null;
      target.afterRemote = null;
    };
  });

  function flushPendingRaw() {
    if (!emitTimer) return;
    clearTimeout(emitTimer);
    emitTimer = null;
    applyRawToLive(getCurrentMarkdown());
  }

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
    if (mode === "raw") rawEditorRef?.focus();
    else editorInstance?.commands.focus();
  }

  export function getEditor(): Editor | null {
    return editorInstance;
  }

  export function insertTranscript(transcript: string): void {
    if (!editorInstance || mode !== "rich") return;
    const { doc, selection } = editorInstance.state;
    const insertion = dictationInsertion(
      transcript,
      doc.textBetween(0, selection.from, "\n", "\n"),
      doc.textBetween(selection.to, doc.content.size, "\n", "\n"),
    );
    if (!insertion) return;
    editorInstance
      .chain()
      .focus()
      .insertContent({ type: "text", text: insertion })
      .run();
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

  export function toggleMode() {
    // Push current content into `value` so the surface we switch to reads it.
    flushPendingEmit();
    if (liveBinding && mode === "rich" && editorInstance) liveRawValue = editorInstance.getMarkdown();
    mode = mode === "rich" ? "raw" : "rich";
    onModeChange?.(mode);
    queueMicrotask(() => {
      if (mode === "raw") {
        rawEditorRef?.focus({ preventScroll: true });
      } else {
        editorInstance?.commands.focus("start", { scrollIntoView: false });
      }
    });
  }

  export function getMode(): "rich" | "raw" {
    return mode;
  }

  export function openLinkPopover() {
    if (!editorInstance) return;
    linkPreview = null;
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

  function openPreviewLink() {
    if (!linkPreview) return;
    void localApi.openExternal(linkPreview.href);
    linkPreview = null;
  }

  function editPreviewLink() {
    if (!editorInstance || !linkPreview) return;
    const { pos } = linkPreview;
    editorInstance.chain().setTextSelection(pos).extendMarkRange("link").run();
    linkPreview = null;
    openLinkPopover();
  }

  function removePreviewLink() {
    if (!editorInstance || !linkPreview) return;
    const { pos } = linkPreview;
    linkPreview = null;
    editorInstance
      .chain()
      .focus()
      .setTextSelection(pos)
      .extendMarkRange("link")
      .unsetLink()
      .run();
  }

  function handleSlashSelect(cmd: EditorBlockCommand) {
    if (!editorInstance) return;
    executeSlashCommand(editorInstance, cmd, slashFrom, slashTo);
  }

  function insertEmbed(choice: WorkEmbedChoice) {
    if (!editorInstance || !embedPicker) return;
    const type = embedPicker === "diagram" ? "diagramEmbed" : "artifactEmbed";
    embedPicker = null;
    editorInstance
      .chain()
      .focus()
      .insertContent([
        { type, attrs: { workId: choice.workId, title: choice.title } },
        { type: "paragraph" },
      ])
      .run();
  }

  function handleContextMenu(e: MouseEvent) {
    if (!editorInstance) return;
    if (e.target instanceof Element && e.target.closest("td, th")) {
      e.preventDefault();
      tableMenuCoords = { x: e.clientX, y: e.clientY };
    }
  }
</script>

<div bind:this={wrapperEl} class="solus-doc-editor-wrap relative {klass}" {style} oncontextmenu={handleContextMenu} role="presentation">
  {#if !editorInstance}
    <ContentSkeleton label="Loading editor" />
  {/if}
  <div
    bind:this={editorDiv}
    class="solus-doc-editor"
    class:doc-mode-hidden={mode === "raw"}
  ></div>

  {#if dictation && mode === "rich"}
    <div class="absolute top-1 right-1 z-10">
      <EditorVoiceControl
        onTranscript={insertTranscript}
        focused={isFocused}
        disabled={readOnly}
        showMic={false}
      />
    </div>
  {/if}

  <RawMarkdownEditor
    bind:this={rawEditorRef}
    value={liveBinding ? liveRawValue : value}
    onValueChange={() => scheduleEmit(liveBinding ? applyRawToLive : onValueChange)}
    onFocus={() => announceFocus(true)}
    onBlur={() => announceFocus(false)}
    {readOnly}
    class={mode === "rich" ? "doc-mode-hidden" : ""}
  />

  {#if slashMenuOpen && slashCoords}
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

  {#if embedPicker}
    <WorkEmbedPicker
      type={embedPicker}
      choices={(embedPicker === "diagram" ? diagramChoices : artifactChoices) ?? []}
      onSelect={insertEmbed}
      onClose={() => {
        embedPicker = null;
        editorInstance?.commands.focus();
      }}
    />
  {/if}

  {#if mode === "rich"}
    <TableChrome
      editor={editorInstance}
      onMenu={(coords) => (tableMenuCoords = coords)}
    />
  {/if}

  {#if tableMenuCoords && editorInstance}
    <TableContextMenu
      editor={editorInstance}
      coords={tableMenuCoords}
      axis={tableMenuCoords.axis}
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

  {#if linkPreview}
    <EditorLinkPreview
      anchorCoords={linkPreview.coords}
      href={linkPreview.href}
      onOpen={openPreviewLink}
      onEdit={editPreviewLink}
      onRemove={removePreviewLink}
      onClose={() => (linkPreview = null)}
    />
  {/if}
</div>
