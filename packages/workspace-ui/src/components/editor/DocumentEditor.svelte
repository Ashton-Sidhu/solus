<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { untrack } from "svelte";
  import { Editor, Extension, type AnyExtension } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import { Markdown } from "@tiptap/markdown";
  import { createMarkdownParser } from "./markdownParser";
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
  import { CellFocus } from "./cellFocus";
  import { DocCodeBlock } from "./codeBlockView";
  import DragHandle from "@tiptap/extension-drag-handle";
  import { lowlight } from "../../lib/lowlight";
  import { SearchExtension } from "./searchExtension";
  import { readAsDataUrl } from "./images";
  import {
    assetFileMarkdown,
    attachmentFilesFromDataTransfer,
    isInlineAssetImage,
    uploadAsset,
  } from "../../lib/asset-upload";
  import {
    getMarkdownImageContext,
    markdownAssetId,
  } from "../conversation/lib/markdown-image";
  import { assetUrlCache } from "../artifact/lib/asset-url";
  import {
    SlashCommandExtension,
    filterCommands,
    executeSlashCommand,
    slashMenuIsOpen,
    askSolusCommand,
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
  import { z } from "zod";
  import RawMarkdownEditor from "./RawMarkdownEditor.svelte";
  import DiagramEmbedPicker from "./DiagramEmbedPicker.svelte";
  import type { DiagramEmbedChoice } from "./diagramEmbedExtension";
  import { linkActivationAction } from "./lib/link-preview";

  const imageSourceSchema = z.string();

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
    diagramChoices?: DiagramEmbedChoice[];
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
    dictation = false,
    extraExtensions = [],
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
  let mode = $state<"rich" | "raw">("rich");
  let isFocused = $state(false);
  let rawEditorRef: RawMarkdownEditor | null = $state(null);
  // Skip the value-sync diff pass when the incoming `value` is our own echo.
  let lastEmittedMd = "";
  const persistedAssetUris = new Map<string, string>();

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
  let diagramPickerOpen = $state(false);

  const slashExtras = $derived([
    ...(diagramChoices ? [embedDiagramCommand(() => (diagramPickerOpen = true))] : []),
    ...(onAskSolus ? [askSolusCommand(onAskSolus)] : []),
  ]);
  const slashFiltered = $derived(filterCommands(slashQuery, slashExtras));
  const slashMenuOpen = $derived(slashMenuIsOpen(slashActive, slashFiltered.length));

  function getMd(editor: Editor): string {
    let markdown = editor.getMarkdown();
    for (const [displayUrl, assetUri] of persistedAssetUris) {
      markdown = markdown.replaceAll(displayUrl, assetUri);
    }
    return markdown;
  }

  async function displayUrlForAsset(assetUri: string): Promise<string> {
    const assetId = markdownAssetId(assetUri);
    const serverId = imageContext?.serverId();
    const api = imageContext?.api();
    if (!assetId || !serverId || !api) return assetUri;
    const displayUrl = await assetUrlCache.resolve({
      serverId,
      assetId,
      origin: serverConnections.httpOriginFor(serverId),
      api,
      ctx: imageContext?.ctx(),
    });
    persistedAssetUris.set(displayUrl, assetUri);
    return displayUrl;
  }

  async function hydrateAssetImages(editor: Editor) {
    const assetUris: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name !== "image") return;
      const src = imageSourceSchema.safeParse(node.attrs.src);
      if (src.success && markdownAssetId(src.data)) assetUris.push(src.data);
    });
    for (const assetUri of assetUris) {
      let displayUrl: string;
      try {
        displayUrl = await displayUrlForAsset(assetUri);
      } catch {
        continue;
      }
      if (displayUrl === assetUri || editor.isDestroyed) continue;
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "image" && node.attrs.src === assetUri) {
          transaction.setNodeMarkup(pos, undefined, { ...node.attrs, src: displayUrl });
        }
      });
      if (transaction.docChanged) editor.view.dispatch(transaction);
    }
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
        Markdown.configure({ marked: createMarkdownParser() }),
        DocCodeBlock.configure({ lowlight }),
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
        // 5.5px either side of the rule is the design's 11px hit zone, hung on
        // the 1px border itself rather than on a strip beside it. cellMinWidth
        // keeps resized columns readable.
        Table.configure({ resizable: true, handleWidth: 5.5, cellMinWidth: 96 }),
        TableRow,
        TableHeader,
        TableCell,
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
      content: initialValue || "",
      contentType: "markdown",
      editable: initialEditable,
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
    void hydrateAssetImages(editor);
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
          src = await displayUrlForAsset(asset.uri);
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
    return editorInstance ? getMd(editorInstance) : lastEmittedMd;
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
    onValueChange(md);
  }

  // Mirror external value resets (e.g. cancel discards editBuffer) and raw-mode edits
  // back into the Tiptap editor — but only when the rich editor is visible. Re-parsing
  // markdown into a ProseMirror doc on every source edit would be
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
      editorInstance.commands.setContent(ext || "", {
        emitUpdate: false,
        contentType: "markdown",
      });
      void hydrateAssetImages(editorInstance);
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

  function insertDiagram(choice: DiagramEmbedChoice) {
    if (!editorInstance) return;
    diagramPickerOpen = false;
    editorInstance
      .chain()
      .focus()
      .insertContent([
        { type: "diagramEmbed", attrs: { workId: choice.workId, title: choice.title } },
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
    {value}
    onValueChange={() => scheduleEmit(onValueChange)}
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

  {#if diagramPickerOpen}
    <DiagramEmbedPicker
      choices={diagramChoices ?? []}
      onSelect={insertDiagram}
      onClose={() => {
        diagramPickerOpen = false;
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

