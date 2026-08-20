<script lang="ts">
  import type { Editor, AnyExtension } from "@tiptap/core";
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import {
    X as XIcon,
    Bold as TextBIcon,
    Italic as TextItalicIcon,
    Strikethrough as TextStrikethroughIcon,
    Code as CodeIcon,
    Link2 as LinkSimpleIcon,
    List as ListBulletsIcon,
    ListOrdered as ListNumbersIcon,
    Quote as QuotesIcon,
    Minus as MinusIcon,
    Table as TableIcon,
    FileType2 as MarkdownLogoIcon,
    CaseSensitive as TextAaIcon,
    Undo2 as ArrowUUpLeftIcon,
    Redo2 as ArrowUUpRightIcon,
    Search as MagnifyingGlassIcon,
    Ellipsis as DotsThreeIcon,
  } from "@lucide/svelte";
  import { runtime, getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import DocumentEditor from "../editor/DocumentEditor.svelte";
  import FindReplaceBar from "../editor/FindReplaceBar.svelte";
  import DocumentOutline from "./DocumentOutline.svelte";
  import SelectionBubble from "./SelectionBubble.svelte";
  import { portal } from "../portal";
  import { extractHeadings, type PlanHeading } from "./headings";
  import { countThreadsByHeading } from "../comments/lib/anchors";
  import { hasOutlineMarginRoom, sectionJumpIndex } from "./lib/outline";
  import { bylineContent } from "./lib/byline";
  import { formatSavedAgo } from "./saveStatus";
  import { isActive, cmd } from "./toolbar";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import type { BindingId } from "../../lib/keybindings/manifest";
  import type { Scope } from "../../lib/keybindings/types";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { createDiagramEmbedExtension } from "../editor/diagramEmbedExtension";
  import { buildGoogleDiagramAssets } from "./lib/google-diagrams";

  interface Props {
    /** Document title. Shown in the header's title cluster (alongside the pane
     *  tab and the document's own H1), and drives the aria-label and rename. */
    title: string;
    /** Where the document lives, shown in mono ahead of the title (e.g. the
     *  project it is stored in). Omitted when there is nothing above it. */
    breadcrumb?: string;
    /** When set, the header title becomes a click-to-rename button. */
    onRenameTitle?: (title: string) => void;
    /** Markdown content rendered in the editor (also the source for Copy). */
    content: string;
    placeholder?: string;
    /** Renders full-pane (editor mode) vs floating modal + backdrop (pill mode). */
    inline?: boolean;
    /** Split-pane documents keep the outline folded until it is needed. */
    minimizeOutline?: boolean;
    /** Consumer-specific class on the editor, used to own its content width/typography. */
    editorClass: string;
    extraExtensions?: AnyExtension[];

    /** Keybinding scope pushed while mounted, and the close/save/copy ids within it. */
    scope: Scope;
    bindings: { close: BindingId; save: BindingId; copy: BindingId; googleUpload?: BindingId; find?: BindingId; pinOutline?: BindingId };

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
        shared shell elements (header, root sizing) to their own instances. */
    rootClass?: string;

    /** Starts a comment on the current selection. Provided by surfaces that
     *  have comments; the bubble's Comment action appears only with it. */
    onCommentSelection?: () => void;
    /** Whether the current selection can actually anchor a comment (the host
     *  owns that rule — e.g. a minimum length). Gates the Comment action so it
     *  is never offered as a button that would do nothing. */
    canCommentSelection?: boolean;
    /** Hands the selected text to the surface's agent. Works only. */
    onAskSolus?: (selectedText: string) => void;

    /** Document position of each comment thread's mark. Drives the outline's
     *  per-section thread counts; surfaces without comments omit it. */
    threadAnchors?: { id: string; pos: number }[];
    /** Width of the margin the `rail` snippet draws threads in, as a CSS
     *  length. Reserved in the page block whether or not threads are showing,
     *  so toggling them never moves the prose. Omitted by surfaces with no
     *  threads at all — they get no margin and centre on the measure alone. */
    railWidth?: string;
    /** Pane width below which the margin stops being a column, in px. The
     *  measure is protected before the margin is: past this the rail folds away
     *  and its surface is told so, rather than the prose shrinking to keep it. */
    railFoldBelow?: number;

    /** Called after the shell wires the editor, so consumers can add listeners. */
    onEditorReady?: (editor: Editor) => void;
    /** Bindable so consumers can drive editor-coupled features (e.g. comments). */
    tiptapEditor?: Editor | null;
    scrollContainer?: HTMLDivElement | null;
    /** Consumers set true around programmatic edits to suppress autosave. */
    suppressSave?: boolean;

    /** Surface-specific status rendered in the header's action cluster (e.g.
     *  the plan's revision picker). */
    documentMeta?: Snippet;
    /** Surface-specific actions rendered at the right end of the header. */
    documentActions?: Snippet<[{
      copied: boolean;
      copy: () => void;
      /** Defined only when this shell has a google-upload binding. */
      googleUpload?: () => void;
      uploading: boolean;
      uploaded: boolean;
      /** Defined only when the title is renameable — flips the header's title
       *  cluster into the rename input. */
      startRename?: () => void;
    }]>;
    rail?: Snippet<[{ folded: boolean }]>;
    footer?: Snippet;
    overlays?: Snippet;
  }

  let {
    title,
    breadcrumb,
    onRenameTitle,
    content,
    placeholder = "",
    inline = false,
    minimizeOutline = false,
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
    onCommentSelection,
    canCommentSelection = false,
    onAskSolus,
    threadAnchors = [],
    railWidth = "0px",
    railFoldBelow = 920,
    onEditorReady,
    tiptapEditor = $bindable(null),
    scrollContainer = $bindable(null),
    suppressSave = $bindable(false),
    documentMeta,
    documentActions,
    rail,
    footer,
    overlays,
  }: Props = $props();

  const isMobile = $derived(runtime.isMobileViewport);
  const session = getWorkspaceContext();
  const diagramEmbedExtension = createDiagramEmbedExtension({
    worksStore: session.worksStore,
    onOpen: (workId) => session.openWork(workId, "aside"),
  });
  const editorExtensions = $derived([...extraExtensions, diagramEmbedExtension]);
  const diagramChoices = $derived(
    Object.values(session.worksStore.works)
      .filter((work) => work.type === "diagram")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((work) => ({ workId: work.id, title: work.title, updatedAt: work.updatedAt })),
  );

  $effect(() => {
    void session.worksStore.loadAll();
  });

  // Pane width, not window width: a narrow split pane on a wide monitor has to
  // fold its margin too, or the measure pays for a rail nobody can read.
  let shellWidth = $state(0);
  const railFolded = $derived(
    railWidth !== "0px" && shellWidth > 0 && shellWidth < railFoldBelow,
  );

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
    if (!runtime.isTouchDevice) return;
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
    const vv = window.visualViewport;
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
      if (e.currentTarget instanceof HTMLInputElement) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renaming = false;
    }
  }

  let copied = $state(false);
  let uploading = $state(false);
  let uploaded = $state(false);
  let isSaving = $state(false);
  let hasPendingSave = $state(false);
  let saveFailed = $state(false);
  let lastSavedAt = $state<number | null>(null);
  let savedStatusNow = $state(Date.now());

  const showSaving = $derived(hasPendingSave || isSaving);

  // Live word count for the document's byline. Driven off stateVersion, which
  // is bumped once per frame on every edit — so it updates live as you type
  // (a 500ms timer made it lag and never settle during continuous typing).
  const wordCount = $derived.by(() => {
    void stateVersion;
    const trimmed = tiptapEditor?.state.doc.textContent.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  });
  const byline = $derived(bylineContent(wordCount));

  // Toolbar undo/redo affordance — re-read on each batched stateVersion bump.
  const canUndo = $derived.by(() => {
    void stateVersion;
    return tiptapEditor?.can().undo() ?? false;
  });
  const canRedo = $derived.by(() => {
    void stateVersion;
    return tiptapEditor?.can().redo() ?? false;
  });

  let tocHeadings = $state<PlanHeading[]>([]);
  // Presence only — the rail's width collapse is a container query on the pane,
  // so a narrow split pane on a wide monitor drops it too.
  const showTocRail = $derived(tocHeadings.length >= 2);
  let activeHeadingPos = $state<number | null>(null);
  const threadCounts = $derived(
    countThreadsByHeading(threadAnchors, tocHeadings.map((h) => h.pos)),
  );
  // Held open by the reader; released only by the same shortcut.
  let outlinePinned = $state(false);
  // Held open while a keyboard jump is settling, so the reader can see where
  // they landed before the labels dissolve.
  let outlineJumping = $state(false);
  // The full contents stay visible at the top in a floating document, then
  // fold to measure bars as soon as the reader scrolls into the document.
  // Split-pane documents stay minimized so the outline does not consume the
  // narrow pane's visual space; hover, pinning, and keyboard jumps can still
  // reveal it on demand.
  let outlineAtTop = $state(true);
  // A narrow pane on a wide monitor has no margin for the panel to unfold into.
  const outlineHasMarginRoom = $derived(
    hasOutlineMarginRoom(shellWidth, runtime.isLaptopDisplay),
  );
  // The reading viewport's height. The margin rail sticks to the top of the
  // scroll region, so it needs the viewport's height rather than the
  // document's — a sticky element cannot get that from its own parent.
  let scrollHeight = $state(0);
  let outlineJumpTimer: ReturnType<typeof setTimeout> | null = null;
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
      if (outlineJumpTimer) clearTimeout(outlineJumpTimer);
    };
  });

  /**
   * ⌥1…⌥9 jump to the nth section, and hold the outline open long enough for
   * the reader to see where the jump landed.
   *
   * Nine digits would be nine manifest entries per shell scope, so this rides
   * on the root element instead of the global keybinding registry: it fires
   * only while focus is inside this document, which is the same gate the
   * scope would have given it.
   */
  function handleSectionJump(e: KeyboardEvent) {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const index = sectionJumpIndex(e.code, tocHeadings.length);
    if (index === null) return;
    e.preventDefault();
    outlineJumping = true;
    if (outlineJumpTimer) clearTimeout(outlineJumpTimer);
    outlineJumpTimer = setTimeout(() => (outlineJumping = false), 900);
    scrollToHeading(tocHeadings[index].pos);
  }

  // Heading scroll-spy: choose the heading whose top is closest above the
  // viewport. P5: coalesce to one rAF per frame so a fast scroll doesn't run
  // N coordsAtPos layout reads per scroll event.
  $effect(() => {
    if (!scrollContainer || !tiptapEditor || tocHeadings.length === 0) return;
    let scrollPending = false;
    const compute = () => {
      scrollPending = false;
      if (!tiptapEditor || !scrollContainer || suppressScrollSpy) return;
      if (!minimizeOutline) outlineAtTop = scrollContainer.scrollTop <= 1;
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
      // Fold immediately rather than waiting for the scroll-spy's next frame.
      if (!minimizeOutline && scrollContainer) outlineAtTop = scrollContainer.scrollTop <= 1;
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(compute);
    };
    compute();
    scrollContainer.addEventListener("scroll", handler, { passive: true });
    return () => scrollContainer?.removeEventListener("scroll", handler);
  });

  // A pane is one keyboard surface beside others, not a modal over the whole
  // workspace. Keep its shortcuts ahead of the global scope without blocking
  // unrelated global actions such as Settings. Standalone modals stay
  // exclusive so background surfaces cannot react through them.
  useScope(() => scope, { exclusive: !untrack(() => inline), pre: true });
  useKeybinding(() => bindings.close, () => {
    if (findOpen) findOpen = false;
    else (onEscape ?? onClose)();
  });
  useKeybinding(() => bindings.save, () => flushSave());
  useKeybinding(() => bindings.copy, () => handleCopy());
  useKeybinding(() => bindings.googleUpload!, handleGoogleUpload, { enabled: () => !!bindings.googleUpload });
  useKeybinding(() => bindings.find!, () => { findOpen = true; }, { enabled: () => !!bindings.find });
  useKeybinding(() => bindings.pinOutline!, () => { outlinePinned = !outlinePinned; }, { enabled: () => !!bindings.pinOutline });

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
    void content;
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
      editorRef?.getCurrentMarkdown() ?? tiptapEditor?.getMarkdown() ?? content;
    await saveContent(md);
  }

  // Copy the *live* editor content, not the (possibly stale, pre-save) prop.
  export function getCurrentMarkdown(): string {
    return (
      editorRef?.getCurrentMarkdown() ?? tiptapEditor?.getMarkdown() ?? content
    );
  }

  function handleCopy() {
    navigator.clipboard
      .writeText(getCurrentMarkdown())
      .then(() => {
        copied = true;
        setTimeout(() => (copied = false), 1800);
      })
      .catch(() => {});
  }

  function googleOAuthCallbackBaseUrl(): string | undefined {
    if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return undefined;
    return window.location.origin;
  }

  async function openUrl(url: string, options?: { hideAppAfterOpen?: boolean }) {
    if (localApi.getPlatform() !== "web") {
      try {
        const opened = await localApi.openExternal(url, options);
        if (opened) return;
      } catch {}
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function handleGoogleUpload() {
    if (uploading) return;
    // Default-host by decision (docs/plans/multi-host-parity.md): the Google
    // OAuth flow is client-global, so the upload runs on the new-work default.
    const defaultServerId = serverConnections.defaultServerId();
    if (!defaultServerId) return;
    const api = serverConnections.apiFor(defaultServerId);
    uploading = true;
    try {
      const markdown = getCurrentMarkdown();
      const diagramAssets = await buildGoogleDiagramAssets(
        markdown,
        (workId) => session.worksStore.ensureContent(workId, "google-doc-upload"),
      );
      const request = {
        title,
        markdown,
        diagramAssets: diagramAssets.length ? diagramAssets : undefined,
        oauthCallbackBaseUrl: googleOAuthCallbackBaseUrl(),
      };
      let result = await api.googleUploadDoc(request);
      if ("authUrl" in result) {
        await openUrl(result.authUrl);
        const deadline = Math.min(result.expiresAt ?? Date.now() + 5 * 60_000, Date.now() + 5 * 60_000);
        while (Date.now() < deadline) {
          await sleep(2000);
          result = await api.googleUploadDoc(request);
          if (!("authUrl" in result)) break;
        }
      }
      if ("error" in result) {
        toasts.error("Couldn't open in Google Docs", { description: result.error });
      } else if ("authUrl" in result) {
        toasts.error("Finish Google sign-in in your browser, then try again.");
      } else if ("docUrl" in result) {
        await openUrl(result.docUrl, { hideAppAfterOpen: true });
        uploaded = true;
        setTimeout(() => (uploaded = false), 1500);
      } else {
        toasts.error("Couldn't open in Google Docs", {
          description: "Google returned an unexpected response.",
        });
      }
    } catch (err) {
      toasts.error("Couldn't open in Google Docs", {
        description: err instanceof Error ? err.message : String(err),
      });
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
    } catch (err) {
      // Keep the dirty flag on failure — clearing it would let the host treat
      // unsaved edits as clean (and an agent refresh clobber them). The header
      // shows a retry affordance and any further edit re-arms the save.
      saveFailed = true;
      toasts.error("Couldn't save document", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      isSaving = false;
    }
  }

  /** Hand the selected prose to the surface's agent. Reads the live selection
   *  rather than tracking it, so it can't go stale between click and send. */
  function handleAskSolus() {
    const editor = tiptapEditor;
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, " ").trim();
    if (selected) onAskSolus?.(selected);
  }

  function scrollToHeading(pos: number) {
    if (!tiptapEditor || !scrollContainer) return;
    const coords = tiptapEditor.view.coordsAtPos(pos);
    const containerTop = scrollContainer.getBoundingClientRect().top;
    // The header sits above the scroll region now, so this is plain breathing
    // room rather than clearance for an overlay.
    const headroom = 24;
    activeHeadingPos = pos;
    suppressScrollSpy = true;
    if (suppressScrollSpyTimer) clearTimeout(suppressScrollSpyTimer);
    suppressScrollSpyTimer = setTimeout(() => {
      suppressScrollSpy = false;
    }, 600);
    scrollContainer.scrollBy({
      top: coords.top - containerTop - headroom,
      behavior: "smooth",
    });
  }
</script>

{#snippet renameField()}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="doc-shell-title-input min-w-24 max-w-96 flex-1 rounded-md border border-(--solus-accent-border) bg-(--solus-surface-hover) px-1.5 py-0.5 text-workspace-chrome font-medium text-(--solus-text-primary) outline-none"
    bind:value={renameValue}
    onblur={commitRename}
    onkeydown={renameKeydown}
    autofocus
    aria-label="Rename document"
    data-testid="rename-work-input"
  />
{/snippet}

{#snippet saveStatusChip()}
  <div class="doc-shell-save-status ml-1 inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-(--solus-text-tertiary) transition-opacity duration-(--duration-base)">
    {#if showSaving}
      <span class="size-[0.3125rem] shrink-0 rounded-full bg-(--solus-accent)" aria-hidden="true"></span>
      <span>Saving…</span>
    {:else if saveFailed}
      <button
        type="button"
        class="mx-[-0.25rem] cursor-pointer whitespace-nowrap rounded-sm border-0 bg-transparent px-1 py-px text-[inherit] font-medium transition-[background,color] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border) motion-reduce:transition-none"
        onclick={() => void flushSave()}
        title="The last save failed — click to retry"
      >
        Retry save
      </button>
    {:else if lastSavedAt !== null}
      <!-- Sage, the one hue that means "saved / resolved" everywhere in the
           document — a dot rather than a tick, so the header stays type. -->
      <span class="size-[0.3125rem] shrink-0 rounded-full bg-(--solus-art-3)" aria-hidden="true"></span>
      <span>{formatSavedAgo(lastSavedAt, savedStatusNow)}</span>
    {/if}
  </div>
{/snippet}

{#snippet toolbarActions()}
  {@render documentActions?.({
    copied,
    copy: handleCopy,
    googleUpload: bindings.googleUpload ? handleGoogleUpload : undefined,
    uploading,
    uploaded,
    startRename: onRenameTitle ? startRename : undefined,
  })}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
{#snippet shellInner()}
  <!-- aria-modal is set only for the true (floating) modal. -->
  <div
    data-testid={rootTestId}
    data-solus-ui
    bind:clientWidth={shellWidth}
    role="dialog"
    aria-label={title}
    aria-modal={inline ? undefined : "true"}
    tabindex="-1"
    onkeydown={handleSectionJump}
    class="doc-shell-root {rootClass} relative [container:doc-shell/inline-size] flex flex-col {inline
 ? 'h-full'
 : 'doc-shell-root--floating h-[min(86vh,90vh)] w-[min(100rem,96vw)] rounded-2xl'} overflow-hidden bg-(--solus-container-bg) {inline
 ? ''
 : 'border border-(--solus-tool-border)'}"
    class:doc-shell-root--inline={inline}
  >
    <!-- Pane-level chrome lives in the floating PaneChrome cluster; the floating
         (pill) modal has no pane around it, so it keeps its own corner close. -->
    {#if !inline}
      <button
        type="button"
        data-testid={closeTestId}
        onclick={onClose}
        class="doc-shell-close absolute right-3 top-2 z-30"
        aria-label="Close"
        title="Close"
      >
        <XIcon size={14} />
      </button>
    {/if}

    <!-- Header, full-bleed above the TOC rail and the text column so it never
         overlays the reading measure. It holds only what stays visible at every
         width: where you are, whether it saved, and the surface's own actions.
         Formatting is not here — it lives at the selection. -->
    <header class="workspace-titlebar doc-shell-toolbar relative flex shrink-0 items-center">
      {#if !isMobile}
      <!-- Left: where you are, and whether it saved. Nothing else earns a
           permanent seat on this side. -->
      <div class="doc-shell-title-cluster flex min-w-0 items-center gap-2.5">
        {#if breadcrumb}
          <span class="doc-shell-breadcrumb" title={breadcrumb}>{breadcrumb} /</span>
        {/if}
        {#if renaming}
          {@render renameField()}
        {:else if onRenameTitle}
          <button type="button" class="doc-shell-title" onclick={startRename} title="{title} — click to rename">{title}</button>
        {:else}
          <span class="doc-shell-title" title={title}>{title}</span>
        {/if}
        {@render saveStatusChip()}
      </div>

      <div class="min-w-4 flex-auto"></div>

      <!-- Right: verbs only. Word count moved to the document's own byline and
           find is ⌘F — neither is a button here any more. -->
      <div class="doc-shell-header-actions flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          class="doc-shell-header-btn"
          onclick={() => editorRef?.toggleMode()}
          title={editorMode === "rich" ? "View raw markdown" : "View rendered editor"}
        >{editorMode === "rich" ? "Markdown" : "Editor"}</button>
        {@render documentMeta?.()}
        {@render toolbarActions()}
      </div>
      {:else}
      <!-- Mobile: curated essentials in one scrollable strip, the rest behind "⋯". -->
      <div class="doc-shell-toolbar-row flex items-center gap-1">
        {#if renaming}
        {@render renameField()}
        {:else}
        <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "bold")} aria-pressed={isActive(tiptapEditor, stateVersion, "bold")} onclick={() => cmd(tiptapEditor, (c) => c.toggleBold())} title="Bold" aria-label="Bold"><TextBIcon size={14} weight="bold" /></button>
        <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "italic")} aria-pressed={isActive(tiptapEditor, stateVersion, "italic")} onclick={() => cmd(tiptapEditor, (c) => c.toggleItalic())} title="Italic" aria-label="Italic"><TextItalicIcon size={14} /></button>
        <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "link")} aria-pressed={isActive(tiptapEditor, stateVersion, "link")} onclick={() => editorRef?.openLinkPopover()} title="Link" aria-label="Link"><LinkSimpleIcon size={14} /></button>

        <div class="doc-shell-toolbar-sep"></div>

        <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 1 })} aria-pressed={isActive(tiptapEditor, stateVersion, "heading", { level: 1 })} onclick={() => cmd(tiptapEditor, (c) => c.toggleHeading({ level: 1 }))} title="Heading 1">H<sub>1</sub></button>
        <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 2 })} aria-pressed={isActive(tiptapEditor, stateVersion, "heading", { level: 2 })} onclick={() => cmd(tiptapEditor, (c) => c.toggleHeading({ level: 2 }))} title="Heading 2">H<sub>2</sub></button>

        <div class="doc-shell-toolbar-sep"></div>

        <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "bulletList")} aria-pressed={isActive(tiptapEditor, stateVersion, "bulletList")} onclick={() => cmd(tiptapEditor, (c) => c.toggleBulletList())} title="Bullet list" aria-label="Bullet list"><ListBulletsIcon size={14} /></button>
        <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "taskList")} aria-pressed={isActive(tiptapEditor, stateVersion, "taskList")} onclick={() => cmd(tiptapEditor, (c) => c.toggleTaskList())} title="Task list" aria-label="Task list"><ListBulletsIcon size={14} /></button>

        <button type="button" class="doc-shell-toolbar-btn" class:active={overflowOpen} aria-pressed={overflowOpen} onclick={() => (overflowOpen = !overflowOpen)} title="More formatting" aria-label="More formatting"><DotsThreeIcon size={14} weight="bold" /></button>

        <div class="min-w-2 flex-auto"></div>

        <button type="button" class="doc-shell-toolbar-btn" onclick={() => editorRef?.toggleMode()} title={editorMode === "rich" ? "View raw markdown" : "View rendered editor"} aria-label="Toggle markdown view">
          {#if editorMode === "rich"}<MarkdownLogoIcon size={14} />{:else}<TextAaIcon size={14} />{/if}
        </button>
        {/if}
        {@render documentMeta?.()}
        {@render toolbarActions()}
      </div>

      {#if overflowOpen}
        <button type="button" class="doc-shell-overflow-backdrop" aria-label="Close menu" onclick={() => (overflowOpen = false)}></button>
        <div class="doc-shell-overflow-menu menu-surface" transition:fly={{ y: -6, duration: 130, opacity: 0 }}>
          <button type="button" class="doc-shell-toolbar-btn" disabled={!canUndo} onclick={() => { cmd(tiptapEditor, (c) => c.undo()); overflowOpen = false; }} title="Undo" aria-label="Undo"><ArrowUUpLeftIcon size={14} /></button>
          <button type="button" class="doc-shell-toolbar-btn" disabled={!canRedo} onclick={() => { cmd(tiptapEditor, (c) => c.redo()); overflowOpen = false; }} title="Redo" aria-label="Redo"><ArrowUUpRightIcon size={14} /></button>
          <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "strike")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleStrike()); overflowOpen = false; }} title="Strikethrough" aria-label="Strikethrough"><TextStrikethroughIcon size={14} /></button>
          <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "code")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleCode()); overflowOpen = false; }} title="Inline code" aria-label="Inline code"><CodeIcon size={14} /></button>
          <button type="button" class="doc-shell-toolbar-btn doc-shell-toolbar-text" class:active={isActive(tiptapEditor, stateVersion, "heading", { level: 3 })} onclick={() => { cmd(tiptapEditor, (c) => c.toggleHeading({ level: 3 })); overflowOpen = false; }} title="Heading 3">H<sub>3</sub></button>
          <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "orderedList")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleOrderedList()); overflowOpen = false; }} title="Numbered list" aria-label="Numbered list"><ListNumbersIcon size={14} /></button>
          <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "blockquote")} onclick={() => { cmd(tiptapEditor, (c) => c.toggleBlockquote()); overflowOpen = false; }} title="Blockquote" aria-label="Blockquote"><QuotesIcon size={14} /></button>
          <button type="button" class="doc-shell-toolbar-btn" onclick={() => { cmd(tiptapEditor, (c) => c.setHorizontalRule()); overflowOpen = false; }} title="Divider" aria-label="Divider"><MinusIcon size={14} /></button>
          <button type="button" class="doc-shell-toolbar-btn" class:active={isActive(tiptapEditor, stateVersion, "table")} onclick={() => { cmd(tiptapEditor, (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })); overflowOpen = false; }} title="Insert table" aria-label="Insert table"><TableIcon size={14} /></button>
          {#if bindings.find}
            <button type="button" class="doc-shell-toolbar-btn" class:active={findOpen} onclick={() => { findOpen = !findOpen; overflowOpen = false; }} title="Find & replace" aria-label="Find and replace"><MagnifyingGlassIcon size={14} /></button>
          {/if}
        </div>
      {/if}
      {/if}
    </header>

    <!-- Content area -->
    <div class="relative flex flex-1 min-h-0">
      {#if findOpen && tiptapEditor}
        <div class="doc-find-sleeve" transition:fly={{ y: -6, duration: 140, opacity: 0 }}>
          <FindReplaceBar editor={tiptapEditor} {scrollContainer} onClose={() => (findOpen = false)} />
        </div>
      {/if}
      {#if showTocRail}
        <div class="doc-shell-toc-sleeve ml-3 shrink-0 grow-0 basis-22 @min-[90rem]:basis-38 pt-10 pr-3.5 pb-8">
          <DocumentOutline
            headings={tocHeadings}
            activePos={activeHeadingPos}
            {threadCounts}
            pinned={outlinePinned}
            jumping={outlineJumping}
            atTop={minimizeOutline || !outlineHasMarginRoom ? false : outlineAtTop}
            onScrollTo={scrollToHeading}
          />
        </div>
      {/if}

      <!-- Scroll region and footer share one column, so a footer composer lines up
           under the text column without having to guess the rails' widths. -->
      <!-- The byline hangs off the document's own H1 (index.css), so it rides
           in as the `content` of a pseudo-element rather than as chrome. -->
      <div
        class="doc-shell-column flex min-w-0 flex-1 flex-col"
        style:--solus-doc-byline={byline}
        style:--solus-doc-rail-w={railFolded ? "0px" : railWidth}
      >
      <!-- svelte-ignore a11y_no_noninteractive_tabindex: Focusable so keyboard users can scroll immediately on open. -->
      <div
        bind:this={scrollContainer}
        bind:clientHeight={scrollHeight}
        class="doc-shell-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain outline-none [-webkit-overflow-scrolling:touch]"
        style:padding-bottom={keyboardInset > 0 ? `${keyboardInset}px` : undefined}
        tabindex="0"
        role="region"
        aria-label={scrollAriaLabel}
      >
        <!-- The page: text and its margin threads, one centered block, the way
             a marked-up sheet of paper is one object. The threads live *inside*
             the scroll region so the page's scrollbar stays out at the pane
             edge instead of drawing a rule between the prose and its margin —
             the rail then sticks to the top of the viewport so cards can hold
             their anchors' lines while the text moves under them. -->
        <div class="doc-shell-page" style:--doc-viewport-h="{scrollHeight}px">
        <!-- Editor -->
        <DocumentEditor
          bind:this={editorRef}
          value={content}
          onValueChange={handleEditorChange}
          onInput={handleEditorInput}
          onEditorReady={handleEditorReady}
          onModeChange={(m) => (editorMode = m)}
          onAskSolus={onAskSolus ? () => onAskSolus("") : undefined}
          extraExtensions={editorExtensions}
          {diagramChoices}
          {placeholder}
          class={editorClass}
        />
        {@render rail?.({ folded: railFolded })}
        </div>
      </div>

      {@render footer?.()}
      </div>
    </div>

    <!-- Formatting lives at the selection, not in a bar. Desktop only: touch
         has no hover and the OS owns the selection menu there, so the mobile
         header keeps its own scrollable strip instead. -->
    {#if !isMobile}
      <SelectionBubble
        editor={tiptapEditor}
        onLink={() => editorRef?.openLinkPopover()}
        onComment={onCommentSelection && canCommentSelection ? onCommentSelection : undefined}
        onAskSolus={onAskSolus ? handleAskSolus : undefined}
      />
    {/if}
  </div>
{/snippet}

{#if inline}
  {@render shellInner()}
{:else}
  <div
    use:portal={document.body}
    class="doc-shell-backdrop fixed inset-0 z-[10000] flex items-center justify-center"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
    role="presentation"
  >
    {@render shellInner()}
  </div>
{/if}

{@render overlays?.()}

<style>
  .doc-shell-backdrop {
    background: radial-gradient(
      circle at 50% 38%,
      color-mix(in srgb, var(--solus-modal-scrim) 82%, transparent) 0%,
      var(--solus-modal-scrim) 72%
    );
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

  /* Header — full-bleed above the rail and the text column. It sits *on* the
     page rather than over it (the scroll region is a sibling below, not
     underneath), so there is no rule and no blur to separate them: the chrome
     and the paper are one surface, and only the type says which is which. */
  .doc-shell-toolbar {
    height: var(--solus-chrome-row-h, 2.5rem);
    padding-left: 1.375rem;
  }
  .doc-shell-root--inline .doc-shell-toolbar {
    height: var(--solus-chrome-row-h, 2.5rem);
    padding-left: max(1.375rem, var(--solus-chrome-lead-inset, 0px));
  }
  /* Where the document lives, in the same mono face as the section numerals. */
  .doc-shell-breadcrumb {
    flex-shrink: 0;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: var(--text-xs);

    color: var(--solus-text-tertiary);
  }
  .doc-shell-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-workspace-chrome);
    font-weight: 500;
    color: var(--solus-text-primary);
    background: transparent;
    border: none;
    padding: 0;
    text-align: left;
  }
  button.doc-shell-title {
    cursor: pointer;
  }
  button.doc-shell-title:hover {
    color: var(--solus-accent);
  }
  button.doc-shell-title:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
    border-radius: 0.25rem;
  }
  /* The header's own verbs are unfilled type — the only filled surface in the
     cluster is the surface's primary action, so the eye finds it first. */
  .doc-shell-header-btn {
    flex-shrink: 0;
    height: 1.5rem;
    padding: 0 0.4375rem;
    border-radius: 0.375rem;
    font-size: var(--text-chrome-dense);
    font-weight: 400;
    color: var(--solus-text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .doc-shell-header-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .doc-shell-header-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .doc-shell-header-actions {
    /* Reserve the room the pane's floating chrome cluster occupies so the
       right-hand document actions never slide under it. Falls back to the
       floating modal's own corner close when there is no pane around us. */
    padding-right: max(0.875rem, var(--solus-pane-chrome-inset, 3.25rem));
  }
  /* No rule between the rail and the column: the ticks are a margin mark on the
     same page, not a sidebar. Overflow stays visible so the outline can unfold
     over the text — the ticks do their own scrolling inside. */
  .doc-shell-toc-sleeve {
    position: relative;
    z-index: 20;
  }
  /* The page — text and its margin threads as one centered block, the width of
     the reading measure plus the margin the threads live in. The rail width is
     reserved whether or not threads are showing, so hiding them never slides
     the prose sideways. 7rem is the editor's own side gutters at the top step
     of the ladder; below that the block is flexing and the cap never binds. */
  .doc-shell-page {
    display: flex;
    align-items: flex-start;
    width: min(100%, calc(var(--solus-doc-measure) + 7rem + var(--solus-doc-rail-w, 0px)));
    margin-inline: auto;
  }
  /* The editor's own `width: 100%` would resolve against the whole page block
     — margin included — so it has to yield to the flex share instead. */
  .doc-shell-page > :global(.solus-doc-editor-wrap) {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
  }
  .doc-shell-toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 0.4375rem;
    font-size: var(--text-sm);
    font-weight: 500;
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
    transform: scale(0.96);
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
  /* Find & replace floats top-right over the editor, clear of the TOC rail. */
  .doc-find-sleeve {
    position: absolute;
    top: 0.75rem;
    right: max(1.25rem, var(--solus-pane-chrome-inset, 0px));
    z-index: 30;
  }
  .doc-shell-toolbar-text {
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .doc-shell-toolbar-text sub {
    font-size: var(--text-xs);
    vertical-align: baseline;
    position: relative;
    top: 0.0625rem;
    margin-left: -0.0313rem;
  }
  .doc-shell-toolbar-sep {
    width: 0.0625rem;
    height: 1.125rem;
    margin: 0 0.25rem;
    background: var(--solus-container-border);
  }

  /* Pane-width ladder. There is no longer a bank of formatting buttons to shed
     by priority — that was the whole reason the old bar broke first in split
     view. What is left is what the design keeps visible at every width: where
     you are, whether it saved, and the surface's own actions. Only the rail
     steps down, and an 88px rail of ticks survives widths the old labelled one
     could not. Driven off the shell container, so a narrow split pane on a wide
     monitor steps down too. */
  @container doc-shell (max-width: 45rem) {
    .doc-shell-toc-sleeve {
      display: none;
    }
  }

  /* Exactly one element in the document scrolls, and this is it — the margin
     rail is a layer inside it rather than a second pane, so the bar rides the
     viewport's right edge, past the rail, and never draws a rule between the
     prose and its threads. The gutter is reserved so a bar appearing on a long
     document can't nudge the rail sideways. */
  .doc-shell-scroll {
    scrollbar-gutter: stable;
  }
  /* The app-wide hairline bar in index.css draws the thumb; the gutter above is
     the only thing this surface needs on top of it. */

  @media (max-width: 767px) {
    .doc-shell-root:not(.h-full) {
      width: 100vw !important;
      height: 100dvh !important;
      border-radius: 0 !important;
      border: none !important;
    }
    /* The header is the strip on mobile: no title cluster (the pane tab already
       shows it), so the row inside sizes the header instead of a fixed 52px. */
    .doc-shell-root--inline .doc-shell-toolbar,
    .doc-shell-toolbar {
      display: block;
      height: auto;
      padding-left: 0;
    }
    /* Scrollable formatting strip with real touch targets (Notion/Docs pattern). */
    .doc-shell-toolbar-row {
      gap: 0.125rem;
      padding: 0.375rem max(0.625rem, var(--solus-pane-chrome-inset, 3.25rem))
        0.375rem 0.625rem;
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
      font-size: var(--text-sm);
    }
    .doc-shell-toolbar-sep {
      height: 1.375rem;
    }
    /* Overflow ("⋯") formatting menu — anchored under the header. */
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
    .doc-shell-header-btn,
    .doc-shell-root {
      transition: none !important;
    }
    .doc-shell-toolbar-btn:active {
      transform: none !important;
    }
  }
</style>
