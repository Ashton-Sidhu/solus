<script lang="ts">
  import type { Editor, AnyExtension } from "@tiptap/core";
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import {
    XIcon,
    CheckIcon,
    TextBIcon,
    TextItalicIcon,
    TextStrikethroughIcon,
    CodeIcon,
    LinkSimpleIcon,
    ListBulletsIcon,
    ListNumbersIcon,
    QuotesIcon,
    MinusIcon,
    TableIcon,
    MarkdownLogoIcon,
    TextAaIcon,
    ArrowUUpLeftIcon,
    ArrowUUpRightIcon,
    MagnifyingGlassIcon,
    DotsThreeIcon,
  } from "phosphor-svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import DocumentEditor from "../editor/DocumentEditor.svelte";
  import FindReplaceBar from "../editor/FindReplaceBar.svelte";
  import PlanTableOfContents from "../plan/PlanTableOfContents.svelte";
  import { portal } from "../portal";
  import { extractHeadings, type PlanHeading } from "./headings";
  import { getMarkdown } from "./markdown";
  import { formatSavedAgo } from "./saveStatus";
  import { isActive, cmd } from "./toolbar";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import type { BindingId } from "../../lib/keybindings/manifest";
  import type { Scope } from "../../lib/keybindings/types";
  import FrameExpandButton from "../layout/FrameExpandButton.svelte";

  interface Props {
    /** Document title shown in the header. */
    title: string;
    /** When set, the title becomes click-to-rename (works only, not plans). */
    onRenameTitle?: (title: string) => void;
    /** Markdown content rendered in the editor (also the source for Copy). */
    content: string;
    placeholder?: string;
    /** Renders full-pane (editor mode) vs floating modal + backdrop (pill mode). */
    inline?: boolean;
    /** Collapse header action labels when the shell is hosted in the split pane. */
    iconOnlyHeaderActions?: boolean;
    /** Consumer-specific class on the editor, used to own its content width/typography. */
    editorClass: string;
    extraExtensions?: AnyExtension[];

    /** Keybinding scope pushed while mounted, and the close/save/copy ids within it. */
    scope: Scope;
    bindings: { close: BindingId; save: BindingId; copy: BindingId; googleUpload?: BindingId; find?: BindingId };

    onSave: (md: string) => void | Promise<void>;
    /** Fires true when there are unsaved edits, false once saved. Lets the host
        decide whether an agent update can safely refresh the editor. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Backdrop click + close button. */
    onClose: () => void;
    /** Escape key. Defaults to onClose; consumers override for escalating dismissal. */
    onEscape?: () => void;

    /** Test/aria hooks (differ per consumer). */
    rootTestId?: string;
    closeTestId?: string;
    scrollAriaLabel?: string;

    /** Marker class on the root, so consumers can scope responsive overrides of
        shared shell elements (toolbar row, root sizing) to their own instances. */
    rootClass?: string;

    /** Extra classes appended to the scroll region (e.g. plan's no-rail gutter). */
    scrollClass?: string;

    /** Called after the shell wires the editor, so consumers can add listeners. */
    onEditorReady?: (editor: Editor) => void;
    /** Bindable so consumers can drive editor-coupled features (e.g. comments). */
    tiptapEditor?: Editor | null;
    scrollContainer?: HTMLDivElement | null;
    /** Consumers set true around programmatic edits to suppress autosave. */
    suppressSave?: boolean;

    titleIcon?: Snippet;
    headerMeta?: Snippet;
    headerActions?: Snippet<[{
      copied: boolean;
      copy: () => void;
      /** Defined only when this shell has a google-upload binding. */
      googleUpload?: () => void;
      uploading: boolean;
      uploaded: boolean;
      uploadError: string | null;
    }]>;
    rail?: Snippet;
    footer?: Snippet;
    overlays?: Snippet;
  }

  let {
    title,
    onRenameTitle,
    content,
    placeholder = "",
    inline = false,
    iconOnlyHeaderActions = false,
    editorClass,
    extraExtensions = [],
    scope,
    bindings,
    onSave,
    onDirtyChange,
    onClose,
    onEscape,
    rootTestId,
    closeTestId,
    scrollAriaLabel = "Document",
    rootClass = "",
    scrollClass = "",
    onEditorReady,
    tiptapEditor = $bindable(null),
    scrollContainer = $bindable(null),
    suppressSave = $bindable(false),
    titleIcon,
    headerMeta,
    headerActions,
    rail,
    footer,
    overlays,
  }: Props = $props();

  const isMobile = $derived(runtime.isMobileViewport);
  const isCompact = $derived(runtime.isCompactViewport);
  const showTocRail = $derived(!isMobile && (!isCompact || runtime.isTouchDevice));

  let editorRef: DocumentEditor | null = $state(null);
  let editorMode = $state<"rich" | "raw">("rich");
  let stateVersion = $state(0);
  let didFocusScrollContainer = $state(false);
  let findOpen = $state(false);
  // Mobile: overflow ("⋯") formatting menu + soft-keyboard inset.
  let overflowOpen = $state(false);
  let keyboardInset = $state(0);

  // Track the on-screen keyboard via visualViewport so the editor can scroll the
  // caret clear of it (touch only; a no-op on desktop where the viewport is static).
  $effect(() => {
    if (!runtime.isTouchDevice || typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    let prev = 0;
    const onChange = () => {
      const next = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      keyboardInset = next;
      // Only pull the caret up when the keyboard first opens — typing handles the
      // rest. Leaves manual scrolling (e.g. reading) untouched.
      if (next > 0 && prev === 0) requestAnimationFrame(ensureCaretVisible);
      prev = next;
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    onChange();
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  });

  /** Keep the caret above the soft keyboard while typing near the page bottom. */
  function ensureCaretVisible() {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!tiptapEditor || !scrollContainer || !vv || keyboardInset <= 0) return;
    try {
      const caret = tiptapEditor.view.coordsAtPos(tiptapEditor.state.selection.head);
      const visibleBottom = vv.offsetTop + vv.height;
      const margin = 28;
      if (caret.bottom > visibleBottom - margin) {
        scrollContainer.scrollTop += caret.bottom - (visibleBottom - margin);
      }
    } catch {
      /* coordsAtPos can throw on a transient position; ignore. */
    }
  }

  // Click-to-rename (works only). Commits on Enter/blur, reverts on Escape.
  let renaming = $state(false);
  let renameValue = $state("");
  function startRename() {
    if (!onRenameTitle) return;
    renameValue = title;
    renaming = true;
  }
  function commitRename() {
    if (!renaming) return;
    renaming = false;
    const next = renameValue.trim();
    if (next && next !== title) onRenameTitle?.(next);
  }
  function renameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement)?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renaming = false;
    }
  }

  let copied = $state(false);
  let uploading = $state(false);
  let uploaded = $state(false);
  let uploadError = $state<string | null>(null);
  let isSaving = $state(false);
  let hasPendingSave = $state(false);
  let saveFailed = $state(false);
  let lastSavedAt = $state<number | null>(null);
  let savedStatusNow = $state(Date.now());

  const showSaving = $derived(hasPendingSave || isSaving);

  // Live word/token counts shown in the toolbar. Driven off stateVersion, which
  // is bumped once per frame on every edit — so they update live as you type
  // (a 500ms timer made them lag and never settle during continuous typing).
  const counts = $derived.by(() => {
    stateVersion;
    const editor = tiptapEditor;
    if (!editor) return { words: 0, tokens: 0 };
    const text = editor.state.doc.textContent;
    const trimmed = text.trim();
    return {
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      // Rough GPT-style estimate: ~4 chars/token. Good enough for a writing aid.
      tokens: Math.ceil(text.length / 4),
    };
  });

  // Toolbar undo/redo affordance — re-read on each batched stateVersion bump.
  const canUndo = $derived.by(() => {
    stateVersion;
    return tiptapEditor?.can().undo() ?? false;
  });
  const canRedo = $derived.by(() => {
    stateVersion;
    return tiptapEditor?.can().redo() ?? false;
  });

  let tocHeadings = $state<PlanHeading[]>([]);
  let activeHeadingPos = $state<number | null>(null);
  let tocTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressScrollSpy = false;
  let suppressScrollSpyTimer: ReturnType<typeof setTimeout> | null = null;
  // P2: coalesce per-transaction toolbar-state invalidation to one rAF tick.
  let statePending = false;

  function keepSavedStatusFresh() {
    const interval = setInterval(() => {
      savedStatusNow = Date.now();
    }, 10_000);
    return () => clearInterval(interval);
  }

  $effect(() => {
    if (lastSavedAt === null) return;
    return keepSavedStatusFresh();
  });

  $effect(() => {
    if (didFocusScrollContainer || !scrollContainer) return;
    didFocusScrollContainer = true;
    blurActiveTextInputOnMobile();
    if (runtime.shouldSuppressFocus) return;
    void tick().then(() => scrollContainer?.focus({ preventScroll: true }));
  });

  $effect(() => {
    return () => {
      if (tocTimer) clearTimeout(tocTimer);
      if (suppressScrollSpyTimer) clearTimeout(suppressScrollSpyTimer);
    };
  });

  // Heading scroll-spy: choose the heading whose top is closest above the
  // viewport. P5: coalesce to one rAF per frame so a fast scroll doesn't run
  // N coordsAtPos layout reads per scroll event.
  $effect(() => {
    if (!scrollContainer || !tiptapEditor || tocHeadings.length === 0) return;
    let scrollPending = false;
    const compute = () => {
      scrollPending = false;
      if (!tiptapEditor || !scrollContainer || suppressScrollSpy) return;
      const atBottom =
        scrollContainer.scrollTop + scrollContainer.clientHeight >=
        scrollContainer.scrollHeight - 2;
      if (atBottom) {
        activeHeadingPos = tocHeadings[tocHeadings.length - 1]?.pos ?? null;
        return;
      }
      const containerTop = scrollContainer.getBoundingClientRect().top;
      let active: number | null = tocHeadings[0]?.pos ?? null;
      for (const h of tocHeadings) {
        try {
          const c = tiptapEditor.view.coordsAtPos(h.pos);
          if (c.top - containerTop <= 64) active = h.pos;
          else break;
        } catch {
          break;
        }
      }
      activeHeadingPos = active;
    };
    const handler = () => {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(compute);
    };
    compute();
    scrollContainer.addEventListener("scroll", handler, { passive: true });
    return () => scrollContainer?.removeEventListener("scroll", handler);
  });

  useScope(() => scope, { exclusive: true, pre: true });
  useKeybinding(() => bindings.close, () => {
    if (findOpen) findOpen = false;
    else (onEscape ?? onClose)();
  });
  useKeybinding(() => bindings.save, () => flushSave());
  useKeybinding(() => bindings.copy, () => handleCopy());
  useKeybinding(() => bindings.googleUpload!, handleGoogleUpload, { enabled: () => !!bindings.googleUpload });
  useKeybinding(() => bindings.find!, () => { findOpen = true; }, { enabled: () => !!bindings.find });

  // P2: one batched bump per frame instead of a queueMicrotask bump per
  // transaction (the toolbar's ~17 isActive reads only need to refresh once).
  function bumpState() {
    if (statePending) return;
    statePending = true;
    requestAnimationFrame(() => {
      statePending = false;
      stateVersion++;
    });
  }

  function handleEditorReady(editor: Editor) {
    tiptapEditor = editor;
    editor.on("selectionUpdate", bumpState);
    editor.on("update", () => {
      bumpState();
      if (tocTimer) clearTimeout(tocTimer);
      tocTimer = setTimeout(() => {
        tocHeadings = extractHeadings(editor);
      }, 150);
    });
    tocHeadings = extractHeadings(editor);
    onEditorReady?.(editor);
  }

  // Content set programmatically (streaming load, revision switch) goes through
  // setContent({ emitUpdate: false }) in DocumentEditor, so the "update" handler
  // above never fires. Re-extract directly off the content prop so the TOC
  // tracks externally-set content instead of waiting for a manual edit.
  $effect(() => {
    content;
    const editor = tiptapEditor;
    if (!editor) return;
    // Defer past this flush so DocumentEditor's value-sync effect has applied
    // setContent before we read the doc (effect ordering isn't guaranteed).
    void tick().then(() => {
      tocHeadings = extractHeadings(editor);
    });
  });

  // Cheap synchronous signal on each edit — mark dirty immediately. The actual
  // (debounced, serialized) save arrives via handleEditorChange.
  function handleEditorInput() {
    if (keyboardInset > 0) requestAnimationFrame(ensureCaretVisible);
    if (suppressSave) return;
    if (!hasPendingSave) {
      hasPendingSave = true;
      onDirtyChange?.(true);
    }
  }

  function handleEditorChange(md: string) {
    // Already debounced inside the editor (off the keystroke hot path).
    if (suppressSave) return;
    void saveContent(md);
  }

  /** Flush any pending debounced save immediately (save keybinding + consumers). */
  export async function flushSave() {
    // Drop the editor's pending debounced emit; we serialize current content
    // here. getCurrentMarkdown is mode-aware (rich serialized OR raw textarea).
    editorRef?.cancelPendingEmit();
    const md =
      editorRef?.getCurrentMarkdown() ??
      (tiptapEditor ? getMarkdown(tiptapEditor) : content);
    await saveContent(md);
  }

  // Copy the *live* editor content, not the (possibly stale, pre-save) prop.
  function currentMarkdown(): string {
    return (
      editorRef?.getCurrentMarkdown() ??
      (tiptapEditor ? getMarkdown(tiptapEditor) : content)
    );
  }

  function handleCopy() {
    navigator.clipboard
      .writeText(currentMarkdown())
      .then(() => {
        copied = true;
        setTimeout(() => (copied = false), 1800);
      })
      .catch(() => {});
  }

  async function handleGoogleUpload() {
    if (uploading) return;
    uploading = true;
    uploadError = null;
    try {
      const markdown = currentMarkdown();
      const result = await window.solus.googleUploadDoc({ title, markdown });
      if ("error" in result) {
        uploadError = result.error;
      } else {
        await window.solus.openExternal(result.docUrl, { hideAppAfterOpen: true });
        uploaded = true;
        setTimeout(() => (uploaded = false), 1500);
      }
    } catch (err) {
      uploadError = err instanceof Error ? err.message : "Upload failed";
    } finally {
      uploading = false;
    }
  }

  async function saveContent(md: string) {
    hasPendingSave = false;
    isSaving = true;
    try {
      await onSave(md);
      saveFailed = false;
      lastSavedAt = Date.now();
      savedStatusNow = lastSavedAt;
      onDirtyChange?.(false);
    } catch {
      // Keep the dirty flag on failure — clearing it would let the host treat
      // unsaved edits as clean (and an agent refresh clobber them). The header
      // shows a retry affordance and any further edit re-arms the save.
      saveFailed = true;
    } finally {
      isSaving = false;
    }
  }

  function scrollToHeading(pos: number) {
    if (!tiptapEditor || !scrollContainer) return;
    const coords = tiptapEditor.view.coordsAtPos(pos);
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const toolbarHeight = 52;
    activeHeadingPos = pos;
    suppressScrollSpy = true;
    if (suppressScrollSpyTimer) clearTimeout(suppressScrollSpyTimer);
    suppressScrollSpyTimer = setTimeout(() => {
      suppressScrollSpy = false;
    }, 600);
    scrollContainer.scrollBy({
      top: coords.top - containerTop - toolbarHeight - 12,
      behavior: "smooth",
    });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
{#snippet shellInner()}
  <!--
    role="dialog" is load-bearing for drag-handle alignment, not just semantics:
    .doc-shell-root sets `container-type` (below), which makes it the containing
    block for the global drag handle's `position: fixed`. The drag-handle library
    only resolves its viewport coords against this element (instead of the
    viewport) when it finds a `[role="dialog"]` ancestor with a non-none
    transform — otherwise the handle lands in the middle of the modal, rows below
    the hovered line. aria-modal is set only for the true (floating) modal.
  -->
  <div
    data-testid={rootTestId}
    data-solus-ui
    role="dialog"
    aria-label={title}
    aria-modal={inline ? undefined : "true"}
    class="doc-shell-root {rootClass} flex flex-col {inline
      ? 'h-full'
      : 'doc-shell-root--floating rounded-2xl'} overflow-hidden bg-(--solus-container-bg) {inline
      ? ''
      : 'border border-(--solus-tool-border)'}"
    style={inline ? "" : "width:min(100rem, 96vw);height:min(86vh, 90vh);"}
  >
    <!-- Header -->
    <div class="doc-shell-header flex items-center justify-between gap-1.5 px-5 py-2 shrink-0 border-b border-(--solus-tool-border)">
      {#if inline}
        <FrameExpandButton variant="sidebar" />
      {/if}
      <div class="doc-shell-header__meta flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {@render titleIcon?.()}
        {#if renaming}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="doc-shell-title-input text-[0.8125rem] font-semibold tracking-[-0.01em]"
            bind:value={renameValue}
            onblur={commitRename}
            onkeydown={renameKeydown}
            autofocus
            aria-label="Rename document"
            data-testid="rename-work-input"
          />
        {:else if onRenameTitle}
          <button
            type="button"
            class="doc-shell-title doc-shell-title--editable text-[0.8125rem] font-semibold text-(--solus-text-primary) tracking-[-0.01em] truncate"
            onclick={startRename}
            title="Rename"
            data-testid="rename-work"
          >{title}</button>
        {:else}
          <span class="doc-shell-title text-[0.8125rem] font-semibold text-(--solus-text-primary) tracking-[-0.01em] truncate">{title}</span>
        {/if}
        {@render headerMeta?.()}
        <div class="doc-shell-save-status">
          {#if showSaving}
            <span class="doc-shell-save-dot" aria-hidden="true"></span>
            <span>Saving…</span>
          {:else if saveFailed}
            <button
              type="button"
              class="doc-shell-save-retry"
              onclick={() => void flushSave()}
              title="The last save failed — click to retry"
            >
              Save failed — retry
            </button>
          {:else if lastSavedAt !== null}
            <CheckIcon size={11} />
            <span>{formatSavedAgo(lastSavedAt, savedStatusNow)}</span>
          {/if}
        </div>
      </div>
      <div class="doc-shell-header__actions flex shrink-0 items-center gap-1" class:doc-shell-header__actions--icon-only={iconOnlyHeaderActions}>
        {@render headerActions?.({
          copied,
          copy: handleCopy,
          googleUpload: bindings.googleUpload ? handleGoogleUpload : undefined,
          uploading,
          uploaded,
          uploadError,
        })}
        <button type="button" data-testid={closeTestId} onclick={onClose} class="doc-shell-close" title="Close">
          <XIcon size={16} />
        </button>
        {#if inline}
          <FrameExpandButton variant="projectPanel" />
        {/if}
      </div>
    </div>

    <!-- Content area -->
    <div class="relative flex flex-1 min-h-0">
      {#if findOpen && tiptapEditor}
        <div class="doc-find-sleeve" transition:fly={{ y: -6, duration: 140, opacity: 0 }}>
          <FindReplaceBar editor={tiptapEditor} {scrollContainer} onClose={() => (findOpen = false)} />
        </div>
      {/if}
      {#if showTocRail}
        <div class="doc-shell-toc-sleeve w-60 shrink-0 overflow-y-auto px-3 py-6" style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain">
          <PlanTableOfContents headings={tocHeadings} activePos={activeHeadingPos} onScrollTo={scrollToHeading} />
        </div>
      {/if}

      <!-- svelte-ignore a11y_no_noninteractive_tabindex: Focusable so keyboard users can scroll immediately on open. -->
      <div
        bind:this={scrollContainer}
        class="doc-shell-scroll flex-1 min-w-0 overflow-y-auto {scrollClass}"
        style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain;{keyboardInset > 0 ? ` padding-bottom:${keyboardInset}px` : ''}"
        tabindex="0"
        role="region"
        aria-label={scrollAriaLabel}
      >
        <!-- Static formatting toolbar -->
        <div class="doc-shell-toolbar sticky top-0 z-10">
          {#if !isMobile}
          <div class="doc-shell-toolbar-row flex items-center gap-1 px-8 pt-3 pb-2">
            <button type="button" class="doc-shell-toolbar-btn" disabled={!canUndo} onclick={() => cmd(tiptapEditor, (c) => c.undo())} title="Undo (⌘Z)" aria-label="Undo"><ArrowUUpLeftIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" disabled={!canRedo} onclick={() => cmd(tiptapEditor, (c) => c.redo())} title="Redo (⌘⇧Z)" aria-label="Redo"><ArrowUUpRightIcon size={15} /></button>

            <div class="doc-shell-toolbar-sep"></div>

            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "bold")} aria-pressed={isActive(tiptapEditor, stateVersion, "bold")} onclick={() => cmd(tiptapEditor, (c) => c.toggleBold())} title="Bold"><TextBIcon size={15} weight="bold" /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "italic")} aria-pressed={isActive(tiptapEditor, stateVersion, "italic")} onclick={() => cmd(tiptapEditor, (c) => c.toggleItalic())} title="Italic"><TextItalicIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "strike")} aria-pressed={isActive(tiptapEditor, stateVersion, "strike")} onclick={() => cmd(tiptapEditor, (c) => c.toggleStrike())} title="Strikethrough"><TextStrikethroughIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "code")} aria-pressed={isActive(tiptapEditor, stateVersion, "code")} onclick={() => cmd(tiptapEditor, (c) => c.toggleCode())} title="Inline code"><CodeIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "link")} aria-pressed={isActive(tiptapEditor, stateVersion, "link")} onclick={() => editorRef?.openLinkPopover()} title="Link (⌥⇧K)"><LinkSimpleIcon size={15} /></button>

            <div class="doc-shell-toolbar-sep"></div>

            <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 1 })} aria-pressed={isActive(tiptapEditor, stateVersion, "heading", { level: 1 })} onclick={() => cmd(tiptapEditor, (c) => c.toggleHeading({ level: 1 }))} title="Heading 1">H<sub>1</sub></button>
            <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 2 })} aria-pressed={isActive(tiptapEditor, stateVersion, "heading", { level: 2 })} onclick={() => cmd(tiptapEditor, (c) => c.toggleHeading({ level: 2 }))} title="Heading 2">H<sub>2</sub></button>
            <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 3 })} aria-pressed={isActive(tiptapEditor, stateVersion, "heading", { level: 3 })} onclick={() => cmd(tiptapEditor, (c) => c.toggleHeading({ level: 3 }))} title="Heading 3">H<sub>3</sub></button>

            <div class="doc-shell-toolbar-sep"></div>

            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "bulletList")} aria-pressed={isActive(tiptapEditor, stateVersion, "bulletList")} onclick={() => cmd(tiptapEditor, (c) => c.toggleBulletList())} title="Bullet list"><ListBulletsIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "orderedList")} aria-pressed={isActive(tiptapEditor, stateVersion, "orderedList")} onclick={() => cmd(tiptapEditor, (c) => c.toggleOrderedList())} title="Numbered list"><ListNumbersIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "taskList")} aria-pressed={isActive(tiptapEditor, stateVersion, "taskList")} onclick={() => cmd(tiptapEditor, (c) => c.toggleTaskList())} title="Task list"><ListBulletsIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "blockquote")} aria-pressed={isActive(tiptapEditor, stateVersion, "blockquote")} onclick={() => cmd(tiptapEditor, (c) => c.toggleBlockquote())} title="Blockquote"><QuotesIcon size={15} /></button>

            <div class="doc-shell-toolbar-sep"></div>

            <button type="button" class="doc-shell-toolbar-btn" onclick={() => cmd(tiptapEditor, (c) => c.setHorizontalRule())} title="Divider"><MinusIcon size={15} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "table")} aria-pressed={isActive(tiptapEditor, stateVersion, "table")} onclick={() => cmd(tiptapEditor, (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))} title="Insert table"><TableIcon size={15} /></button>

            <div class="doc-shell-toolbar-sep"></div>

            <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-mode" onclick={() => editorRef?.toggleMode()} title={editorMode === "rich" ? "View raw markdown" : "View rendered editor"}>
              {#if editorMode === "rich"}
                <MarkdownLogoIcon size={14} /><span>Markdown</span>
              {:else}
                <TextAaIcon size={14} /><span>Editor</span>
              {/if}
            </button>

            <div class="doc-shell-toolbar-spacer"></div>

            {#if counts.words > 0}
              <span class="doc-shell-count" title="{counts.words.toLocaleString()} words · ~{counts.tokens.toLocaleString()} tokens">
                {counts.words.toLocaleString()} words · ~{counts.tokens.toLocaleString()} tokens
              </span>
            {/if}
            {#if bindings.find}
              <button type="button" class="doc-shell-toolbar-btn" class:active={findOpen} aria-pressed={findOpen} onclick={() => (findOpen = !findOpen)} title="Find & replace (⌘F)" aria-label="Find and replace"><MagnifyingGlassIcon size={15} /></button>
            {/if}
          </div>
          {:else}
          <!-- Mobile: curated essentials, the rest behind a "⋯" overflow menu. -->
          <div class="doc-shell-toolbar-row flex items-center gap-1">
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "bold")} aria-pressed={isActive(tiptapEditor, stateVersion, "bold")} onclick={() => cmd(tiptapEditor, (c) => c.toggleBold())} title="Bold" aria-label="Bold"><TextBIcon size={18} weight="bold" /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "italic")} aria-pressed={isActive(tiptapEditor, stateVersion, "italic")} onclick={() => cmd(tiptapEditor, (c) => c.toggleItalic())} title="Italic" aria-label="Italic"><TextItalicIcon size={18} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "link")} aria-pressed={isActive(tiptapEditor, stateVersion, "link")} onclick={() => editorRef?.openLinkPopover()} title="Link" aria-label="Link"><LinkSimpleIcon size={18} /></button>

            <div class="doc-shell-toolbar-sep"></div>

            <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 1 })} aria-pressed={isActive(tiptapEditor, stateVersion, "heading", { level: 1 })} onclick={() => cmd(tiptapEditor, (c) => c.toggleHeading({ level: 1 }))} title="Heading 1">H<sub>1</sub></button>
            <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 2 })} aria-pressed={isActive(tiptapEditor, stateVersion, "heading", { level: 2 })} onclick={() => cmd(tiptapEditor, (c) => c.toggleHeading({ level: 2 }))} title="Heading 2">H<sub>2</sub></button>

            <div class="doc-shell-toolbar-sep"></div>

            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "bulletList")} aria-pressed={isActive(tiptapEditor, stateVersion, "bulletList")} onclick={() => cmd(tiptapEditor, (c) => c.toggleBulletList())} title="Bullet list" aria-label="Bullet list"><ListBulletsIcon size={18} /></button>
            <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "taskList")} aria-pressed={isActive(tiptapEditor, stateVersion, "taskList")} onclick={() => cmd(tiptapEditor, (c) => c.toggleTaskList())} title="Task list" aria-label="Task list"><ListBulletsIcon size={18} /></button>

            <button type="button" class="doc-shell-toolbar-btn" class:active={overflowOpen} aria-pressed={overflowOpen} onclick={() => (overflowOpen = !overflowOpen)} title="More formatting" aria-label="More formatting"><DotsThreeIcon size={20} weight="bold" /></button>

            <div class="doc-shell-toolbar-spacer"></div>

            <button type="button" class="doc-shell-toolbar-btn" onclick={() => editorRef?.toggleMode()} title={editorMode === "rich" ? "View raw markdown" : "View rendered editor"} aria-label="Toggle markdown view">
              {#if editorMode === "rich"}<MarkdownLogoIcon size={17} />{:else}<TextAaIcon size={17} />{/if}
            </button>
          </div>

          {#if overflowOpen}
            <button type="button" class="doc-shell-overflow-backdrop" aria-label="Close menu" onclick={() => (overflowOpen = false)}></button>
            <div class="doc-shell-overflow-menu" transition:fly={{ y: -6, duration: 130, opacity: 0 }}>
              <button type="button" class="doc-shell-toolbar-btn" disabled={!canUndo} onclick={() => { cmd(tiptapEditor, (c) => c.undo()); overflowOpen = false; }} title="Undo" aria-label="Undo"><ArrowUUpLeftIcon size={18} /></button>
              <button type="button" class="doc-shell-toolbar-btn" disabled={!canRedo} onclick={() => { cmd(tiptapEditor, (c) => c.redo()); overflowOpen = false; }} title="Redo" aria-label="Redo"><ArrowUUpRightIcon size={18} /></button>
              <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "strike")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleStrike()); overflowOpen = false; }} title="Strikethrough" aria-label="Strikethrough"><TextStrikethroughIcon size={18} /></button>
              <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "code")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleCode()); overflowOpen = false; }} title="Inline code" aria-label="Inline code"><CodeIcon size={18} /></button>
              <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 3 })} onclick={() => { cmd(tiptapEditor, (c) => c.toggleHeading({ level: 3 })); overflowOpen = false; }} title="Heading 3">H<sub>3</sub></button>
              <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "orderedList")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleOrderedList()); overflowOpen = false; }} title="Numbered list" aria-label="Numbered list"><ListNumbersIcon size={18} /></button>
              <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "blockquote")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleBlockquote()); overflowOpen = false; }} title="Blockquote" aria-label="Blockquote"><QuotesIcon size={18} /></button>
              <button type="button" class="doc-shell-toolbar-btn" onclick={() => { cmd(tiptapEditor, (c) => c.setHorizontalRule()); overflowOpen = false; }} title="Divider" aria-label="Divider"><MinusIcon size={18} /></button>
              <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "table")} onclick={() => { cmd(tiptapEditor, (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })); overflowOpen = false; }} title="Insert table" aria-label="Insert table"><TableIcon size={18} /></button>
              {#if bindings.find}
                <button type="button" class="doc-shell-toolbar-btn" class:active={findOpen} onclick={() => { findOpen = !findOpen; overflowOpen = false; }} title="Find & replace" aria-label="Find and replace"><MagnifyingGlassIcon size={18} /></button>
              {/if}
            </div>
          {/if}
          {/if}
        </div>

        <!-- Editor -->
        <DocumentEditor
          bind:this={editorRef}
          value={content}
          onValueChange={handleEditorChange}
          onInput={handleEditorInput}
          onEditorReady={handleEditorReady}
          onModeChange={(m) => (editorMode = m)}
          {extraExtensions}
          {placeholder}
          class={editorClass}
        />
      </div>

      {@render rail?.()}
    </div>

    {@render footer?.()}
  </div>
{/snippet}

{#if inline}
  {@render shellInner()}
{:else}
  <div
    use:portal={document.body}
    class="doc-shell-backdrop fixed inset-0 flex items-center justify-center"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
    role="presentation"
    style="z-index:10000"
  >
    {@render shellInner()}
  </div>
{/if}

{@render overlays?.()}

<style>
  .doc-shell-root {
    container: doc-shell / inline-size;
    /* Identity transform so the root reports a non-none transform. The global
       drag-handle library keys its dialog-relative positioning off
       `[role="dialog"]` + a transform (see the role="dialog" note in markup) —
       without this the handle, which is `position: fixed` inside this
       container-block, drifts to the middle of the editor. */
    transform: translate(0);
  }
  .doc-shell-root--floating {
    box-shadow:
      var(--solus-popover-shadow),
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.1);
  }
  :global(.dark) .doc-shell-root--floating {
    box-shadow:
      var(--solus-popover-shadow),
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.05);
  }

  .doc-shell-backdrop {
    background: var(--solus-modal-scrim);
    backdrop-filter: blur(0.5rem) saturate(1.05);
    -webkit-backdrop-filter: blur(0.5rem) saturate(1.05);
  }

  .doc-shell-header {
    position: relative;
    /* In the editor's secondary pane the header shares the tab strip's chrome
       row — match its height and seam so they read as one continuous bar. */
    min-height: var(--solus-chrome-row-h, auto);
    border-bottom-color: var(--solus-chrome-row-border, var(--solus-tool-border));
  }

  .doc-shell-title--editable {
    background: transparent;
    border: none;
    padding: 0.125rem 0.25rem;
    margin-inline: -0.25rem;
    border-radius: 0.375rem;
    cursor: text;
    text-align: left;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .doc-shell-title--editable:hover {
    background: var(--solus-surface-hover);
  }
  .doc-shell-title--editable:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .doc-shell-title-input {
    min-width: 6rem;
    max-width: 24rem;
    padding: 0.125rem 0.25rem;
    margin-inline: -0.25rem;
    border-radius: 0.375rem;
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
    border: 0.0625rem solid var(--solus-accent-border);
    outline: none;
  }

  .doc-shell-close {
    width: 1.5rem;
    height: 1.5rem;
    margin-left: 0.125rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    border: none;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .doc-shell-close:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .doc-shell-close:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }

  .doc-shell-save-status {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-width: 0;
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    transition: opacity var(--duration-base) ease;
    white-space: nowrap;
  }
  .doc-shell-save-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: var(--solus-accent);
    flex-shrink: 0;
  }
  .doc-shell-save-retry {
    border: none;
    background: transparent;
    padding: 0.0625rem 0.25rem;
    margin-inline: -0.25rem;
    border-radius: 0.25rem;
    font-size: inherit;
    font-weight: 500;
    color: var(--solus-status-error);
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .doc-shell-save-retry:hover {
    background: color-mix(in srgb, var(--solus-status-error) 10%, transparent);
  }
  .doc-shell-save-retry:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }

  /* Toolbar */
  .doc-shell-toolbar {
    background: color-mix(in srgb, var(--solus-container-bg) 92%, transparent);
    backdrop-filter: blur(1.25rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.1);
    box-shadow:
      0 0.0625rem 0 var(--solus-message-divider),
      0 0.25rem 0.75rem rgba(0, 0, 0, 0.04);
  }
  .doc-shell-toolbar-row {
    max-width: 62.5rem;
    margin-inline: auto;
  }
  .doc-shell-toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    border-radius: 0.375rem;
    color: var(--solus-text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  .doc-shell-toolbar-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .doc-shell-toolbar-btn:active {
    transform: scale(0.94);
  }
  .doc-shell-toolbar-btn.active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  .doc-shell-toolbar-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .doc-shell-toolbar-btn:disabled:hover {
    background: transparent;
    color: var(--solus-text-tertiary);
  }
  .doc-shell-toolbar-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .doc-shell-toolbar-spacer {
    flex: 1 1 auto;
    min-width: 0.5rem;
  }
  .doc-shell-count {
    flex-shrink: 0;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
    padding-inline: 0.25rem;
    user-select: none;
  }

  /* Find & replace floats top-right over the editor, clear of the TOC rail. */
  .doc-find-sleeve {
    position: absolute;
    top: 0.75rem;
    right: 1.25rem;
    z-index: 30;
  }
  .doc-shell-toolbar-text {
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .doc-shell-toolbar-text sub {
    font-size: 0.625rem;
    vertical-align: baseline;
    position: relative;
    top: 0.0625rem;
    margin-left: -0.0313rem;
  }
  .doc-shell-toolbar-sep {
    width: 0.0625rem;
    height: 1rem;
    margin: 0 0.375rem;
    background: var(--solus-container-border);
    opacity: 0.4;
  }
  .doc-shell-toolbar-mode {
    width: auto;
    gap: 0.3125rem;
    padding: 0 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    border-radius: 0.4375rem;
    box-shadow: inset 0 0 0 0.0625rem var(--solus-tool-border);
  }
  .doc-shell-toolbar-mode:hover {
    box-shadow: inset 0 0 0 0.0625rem var(--solus-popover-border);
    background: var(--solus-surface-hover);
  }

  /* Inner scrollbars fade in only while the column is interacted with. */
  .doc-shell-scroll,
  .doc-shell-toc-sleeve {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
    transition: scrollbar-color var(--duration-base) var(--ease-premium);
  }
  .doc-shell-scroll:focus {
    outline: none;
  }
  .doc-shell-scroll:hover,
  .doc-shell-scroll:focus-within,
  .doc-shell-toc-sleeve:hover,
  .doc-shell-toc-sleeve:focus-within {
    scrollbar-color: var(--solus-scroll-thumb) transparent;
  }
  .doc-shell-scroll::-webkit-scrollbar-thumb,
  .doc-shell-toc-sleeve::-webkit-scrollbar-thumb {
    background: transparent;
    transition: background var(--duration-base) var(--ease-premium);
  }
  .doc-shell-scroll:hover::-webkit-scrollbar-thumb,
  .doc-shell-scroll:focus-within::-webkit-scrollbar-thumb,
  .doc-shell-toc-sleeve:hover::-webkit-scrollbar-thumb,
  .doc-shell-toc-sleeve:focus-within::-webkit-scrollbar-thumb {
    background: var(--solus-scroll-thumb);
  }

  @media (max-width: 767px) {
    .doc-shell-root:not(.h-full) {
      width: 100vw !important;
      height: 100dvh !important;
      border-radius: 0 !important;
      border: none !important;
    }
    .doc-shell-backdrop {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    .doc-shell-save-status {
      display: none;
    }
    /* Scrollable formatting strip with real touch targets (Notion/Docs pattern). */
    .doc-shell-toolbar-row {
      max-width: none;
      gap: 0.125rem;
      padding: 0.375rem 0.625rem;
      overflow-x: auto;
      scrollbar-width: none;
      flex-wrap: nowrap;
      -webkit-overflow-scrolling: touch;
    }
    .doc-shell-toolbar-row::-webkit-scrollbar {
      display: none;
    }
    .doc-shell-toolbar-btn {
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
    .doc-shell-toolbar-btn :global(svg) {
      width: 1.1875rem;
      height: 1.1875rem;
    }
    .doc-shell-toolbar-text {
      font-size: 1rem;
    }
    .doc-shell-toolbar-mode {
      height: 2.5rem;
      gap: 0.375rem;
      padding: 0 0.625rem;
      font-size: 0.75rem;
    }
    .doc-shell-toolbar-sep {
      height: 1.375rem;
      margin: 0 0.25rem;
    }
    /* Word/token count would only crowd the curated strip on mobile. */
    .doc-shell-count {
      display: none;
    }
    /* Overflow ("⋯") formatting menu — anchored under the sticky toolbar. */
    .doc-shell-overflow-backdrop {
      position: fixed;
      inset: 0;
      z-index: 39;
      background: transparent;
      border: none;
      cursor: default;
    }
    .doc-shell-overflow-menu {
      position: absolute;
      top: calc(100% - 0.25rem);
      right: 0.5rem;
      z-index: 40;
      display: grid;
      grid-template-columns: repeat(5, 2.5rem);
      gap: 0.125rem;
      padding: 0.375rem;
      background: var(--solus-popover-bg);
      border: 0.0625rem solid var(--solus-popover-border);
      border-radius: 0.875rem;
      box-shadow: var(--solus-popover-shadow);
    }
    .doc-find-sleeve {
      left: 0.75rem;
      right: 0.75rem;
    }
    .doc-find-sleeve :global(.doc-find-bar) {
      min-width: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .doc-shell-close,
    .doc-shell-toolbar,
    .doc-shell-toolbar-btn,
    .doc-shell-toolbar-mode,
    .doc-shell-root {
      transition: none !important;
    }
    .doc-shell-toolbar-btn:active {
      transform: none !important;
    }
  }
</style>
