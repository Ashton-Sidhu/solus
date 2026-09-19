<script lang="ts">
  import type { SessionMeta, WorkStorage } from "@solus/contracts/types";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import ParentPageCrumb from "../ui/list-page/ParentPageCrumb.svelte";
  import type { WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import type { FilePayload } from "../diagram/lib/diagram-export";
  import ArtifactView from "./ArtifactView.svelte";
  import ArtifactCommentLayer from "./ArtifactCommentLayer.svelte";
  import * as Select from "../ui/select";
  import { Download as DownloadIcon, RotateCw as ReloadIcon, MessageSquare as CommentsIcon, MessageSquarePlus as PinIcon } from "@lucide/svelte";
  import { downloadPayload } from "../work/lib/work-export";
  import { exportFileName } from "../pickers/lib/export-file-name";
  import { ARTIFACT_WIDTH_OPTIONS, artifactWidthFor } from "./lib/artifact-viewport";
  import { getWorkspaceContext, presenceStore, sharesStore } from "../../contexts";
  import { setCommentViewer, workCommentViewer } from "../comments/lib/comment-viewer";
  import { openThreads } from "../comments/lib/thread";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { uuid } from "@solus/contracts/uuid";
  import type { CommentPin } from "@solus/contracts/types";

  /**
   * The pane surface for an `artifact` work: the works header the document
   * and diagram shells share, over the same sandboxed render the conversation
   * shows. There is no editor — an artifact is revised by the agent through
   * `update_work`, and the header's History/Restore covers what it changed.
   */
  interface Props {
    content: string;
    title: string;
    workId: string;
    onClose: () => void;
    onOpenChat?: (mode: "resume" | "new") => void;
    originalSessionMeta?: SessionMeta | null;
    onRename?: (title: string) => void;
    onRevert?: () => void;
    onDelete?: () => void;
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
    /** Opens the save picker on a chosen format; absent when there is no host. */
    onExport?: (request: WorkExportRequest) => void;
    /** The save picker's filesystem is not this device's — see WorkHeaderActions. */
    hostIsRemote?: boolean;
    /** Leave the artifact for the Workspace page it lives in. */
    onOpenWorkspace?: () => void;
  }

  let {
    content,
    title,
    workId,
    onClose,
    onOpenChat,
    originalSessionMeta,
    onRename,
    onRevert,
    onDelete,
    onDuplicate,
    workStorage,
    onExport,
    hostIsRemote = false,
    onOpenWorkspace,
  }: Props = $props();

  // Click-to-rename, mirroring DiagramShell.
  let renaming = $state(false);
  let renameValue = $state("");
  function startRename() {
    if (!onRename) return;
    renameValue = title;
    renaming = true;
  }
  function commitRename() {
    if (!renaming) return;
    renaming = false;
    const next = renameValue.trim();
    if (next && next !== title) onRename?.(next);
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
  function copyHtml() {
    navigator.clipboard.writeText(content).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    });
  }

  // The one file an artifact is: its own HTML document, openable in any browser.
  const htmlPayload = (): FilePayload | null =>
    content.trim() ? { contents: content, encoding: "utf8" } : null;
  const exportFormats: WorkExportFormat[] = [
    { extension: "html", label: "HTML", mimeType: "text/html", produce: htmlPayload },
  ];

  // There is no source view: an artifact work has no file to edit, so the
  // markup leaves the pane as a file instead. The picker writes to this
  // machine when the host is here; otherwise the browser downloads it.
  function saveAsHtml() {
    const payload = htmlPayload();
    if (!payload) return;
    const fileName = exportFileName(title, "html");
    if (onExport && !hostIsRemote) onExport({ fileName, payload });
    else downloadPayload(fileName, "text/html", payload);
  }

  // A width to check the render against, from the browser pane's own catalogue.
  // Resting state is the pane's width; a fixed width is a deliberate check.
  let widthChoice = $state("fit");
  const pinnedWidth = $derived(artifactWidthFor(widthChoice));

  /** Re-creates the iframe, which is the only way to restart a render that has
   *  drifted — a finished animation, a fetch that failed. */
  let reloadKey = $state(0);

  const artifact = $derived({ kind: "html" as const, html: content });

  // ─── Comments (docs/plans/multiplayer-comments.md §4) ───
  // Threads pinned to points over the render, on the same host-stamped model as
  // a document's or a diagram's: the store sends commands, the host names who
  // wrote what, and everyone who can open the work hears the change.
  const session = getWorkspaceContext();
  const serverId = $derived(session.worksStore.hostFor(workId));
  const shareResource = $derived({ kind: "work" as const, id: workId });
  setCommentViewer(() => workCommentViewer(session.worksStore.hostFor(workId), { kind: "work", id: workId }));
  const comments = $derived(session.worksStore.annotationComments(workId));
  const openCommentCount = $derived(openThreads(comments).length);
  // A viewer on the share list reads the threads; the host would refuse a
  // comment anyway, so the pin tool is not offered.
  const commentsReadOnly = $derived(!!serverId && sharesStore.listFor(serverId, shareResource)?.callerRole === "viewer");

  let pinArmed = $state(false);
  let draftPin = $state<CommentPin | null>(null);
  let openThreadId = $state<string | null>(null);
  let commentListOpen = $state(false);
  const hasCommentOverlay = $derived(pinArmed || draftPin !== null || openThreadId !== null || commentListOpen);

  $effect(() => {
    const id = workId;
    void session.worksStore.loadAnnotations(id);
    // Who the reader is on this host, so their own threads carry no byline.
    if (serverId) void presenceStore.ensure(serverId);
    return session.worksStore.watchAnnotations(id);
  });

  let threadClockNow = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (threadClockNow = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  function addPinnedComment(pin: CommentPin, label: string, text: string) {
    const id = uuid();
    void session.worksStore.addAnnotationComment(workId, { id, selectedText: label, comment: text, pin });
    openThreadId = id;
  }

  function dismissCommentOverlay() {
    if (draftPin) draftPin = null;
    else if (openThreadId) openThreadId = null;
    else if (commentListOpen) commentListOpen = false;
    else pinArmed = false;
  }

  useScope("artifact");
  useKeybinding("artifact.comment", () => {
    if (commentsReadOnly) return;
    pinArmed = !pinArmed;
    if (pinArmed) draftPin = null;
  });
  useKeybinding("artifact.dismiss", dismissCommentOverlay, { enabled: () => hasCommentOverlay });
</script>

<div
  class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)"
  data-testid="artifact-shell"
>
  <!-- Same de-chromed control strip as the diagram shell: the pane's own
       close / split live in the floating PaneChrome cluster, which
       this row reserves room for on its right.

       The chrome row is a *floor*, not a fixed height. It used to be fixed with
       a `max-md:` escape hatch — but that reads the OS window, and this row
       lives in a pane: a diagram in a 356px companion pane on a 1440px monitor
       kept the 40px height while its controls grew past it. Two different
       things enlarge this row and neither is the window. The hand does (touch
       targets are 44px), and so does the narrow layout, where the crumb becomes
       a 44px back chevron. `h-auto` + `min-h` fits whichever is tallest without
       having to enumerate them. -->
  <div
    class="workspace-titlebar flex h-auto min-h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center gap-1.5 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))] pr-[max(1rem,var(--solus-pane-chrome-inset,0px))] @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-1 @max-[30rem]/pane:pl-2"
  >
    {#if onOpenWorkspace}
      <!-- The optical inset pulls a *word* back onto the row's edge. A chevron
           is already centred in its own 44px box, so the rung gives it back. -->
      <span class="-ml-[7px] flex shrink-0 items-center @max-[30rem]/pane:ml-0">
        <ParentPageCrumb page="folio" onOpen={onOpenWorkspace} />
      </span>
    {/if}
    {#if renaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="min-w-24 max-w-96 flex-1 rounded-md border border-(--solus-accent-border) bg-(--solus-surface-hover) px-1 py-0.5 text-workspace-chrome font-medium text-(--solus-text-primary) outline-none"
        bind:value={renameValue}
        onblur={commitRename}
        onkeydown={renameKeydown}
        autofocus
        aria-label="Rename artifact"
        data-testid="rename-work-input"
      />
    {:else}
      <button
        type="button"
        class="min-w-0 flex-1 cursor-text truncate border-0 bg-transparent text-left text-workspace-chrome font-medium text-(--solus-text-primary)"
        onclick={startRename}
        disabled={!onRename}
        title={onRename ? "Rename" : undefined}
        data-testid="artifact-shell-title"
      >
        {title}
      </button>
    {/if}
    <!-- The pane's own tools share one geometry (`.artifact-tool`) with the
         header verbs beside them, so the row reads as one strip at every
         display size rather than three controls of three heights. -->
    {#if content.trim()}
      <button
        type="button"
        class="artifact-tool"
        title="Save as HTML"
        aria-label="Save as HTML"
        data-testid="artifact-shell-save-html"
        onclick={saveAsHtml}
      >
        <DownloadIcon size={14} />
      </button>
    {/if}
    {#if !commentsReadOnly}
      <button
        type="button"
        class="artifact-tool"
        class:is-active={pinArmed}
        title="Comment on the render (⌥C)"
        aria-label="Comment on the render"
        aria-pressed={pinArmed}
        data-testid="artifact-shell-pin-comment"
        onclick={() => {
          pinArmed = !pinArmed;
          if (pinArmed) draftPin = null;
        }}
      >
        <PinIcon size={14} />
      </button>
    {/if}
    {#if comments.length > 0}
      <button
        type="button"
        class="artifact-tool artifact-tool--labelled"
        class:is-active={commentListOpen}
        title={commentListOpen ? "Hide comments" : "Show comments"}
        aria-label={commentListOpen ? "Hide comments" : "Show comments"}
        aria-pressed={commentListOpen}
        data-testid="artifact-shell-comments"
        onclick={() => (commentListOpen = !commentListOpen)}
      >
        <CommentsIcon size={14} />
        <span class="text-workspace-chrome tabular-nums">{openCommentCount}</span>
      </button>
    {/if}
    <Select.Root type="single" value={widthChoice} onValueChange={(next) => (widthChoice = next)}>
      <Select.Trigger
        aria-label="Render width"
        title="Render width"
        size="sm"
        class="artifact-tool artifact-tool--labelled border-0 bg-transparent py-0 text-workspace-chrome focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent [&_svg]:size-2.5"
      >
        {ARTIFACT_WIDTH_OPTIONS.find((option) => option.value === widthChoice)?.label ?? "Fit"}
      </Select.Trigger>
      <Select.Content side="bottom" align="end" sideOffset={5} class="z-[10002] max-h-72 w-52">
        {#each ARTIFACT_WIDTH_OPTIONS as option (option.value)}
          <Select.Item value={option.value} label={option.label} class="text-workspace-chrome" />
        {/each}
      </Select.Content>
    </Select.Root>
    <button
      type="button"
      class="artifact-tool"
      title="Reload the render"
      aria-label="Reload the render"
      data-testid="artifact-shell-reload"
      onclick={() => (reloadKey += 1)}
    >
      <ReloadIcon size={14} />
    </button>
    <WorkHeaderActions
      {onOpenChat}
      onStartRename={onRename ? startRename : undefined}
      {originalSessionMeta}
      {copied}
      copy={copyHtml}
      {workId}
      {title}
      currentContent={content}
      {exportFormats}
      {onExport}
      {hostIsRemote}
      {onRevert}
      {onDelete}
      {onDuplicate}
      {workStorage}
    />
  </div>

  <!-- A short render fills the pane; a taller render keeps its content height
       and scrolls here instead of introducing a second iframe scrollbar. -->
  <div class="min-h-0 flex-1 overflow-auto p-4" data-testid="artifact-shell-body">
    <!-- A pinned width centres the render so the pane reads as a device
         frame rather than a left-aligned column with dead space. The box is
         as tall as the render, so the comment layer over it covers every
         point a pin can be dropped on. -->
    <div
      class="relative mx-auto min-h-full"
      style:width={pinnedWidth ? `${pinnedWidth}px` : undefined}
    >
      <ArtifactView {artifact} {reloadKey} fillAvailable skipMotion />
      <ArtifactCommentLayer
        {comments}
        readOnly={commentsReadOnly}
        bind:armed={pinArmed}
        bind:draftPin
        bind:openThreadId
        bind:listOpen={commentListOpen}
        now={threadClockNow}
        onAdd={addPinnedComment}
        onEdit={(commentId, text) => void session.worksStore.editAnnotationComment(workId, commentId, text)}
        onDelete={(commentId) => void session.worksStore.deleteAnnotationComment(workId, commentId)}
        onReply={(commentId, text) => void session.worksStore.addAnnotationReply(workId, commentId, { id: uuid(), author: "you", text, createdAt: Date.now() })}
        onResolve={(commentId, resolved) => void session.worksStore.setAnnotationResolved(workId, commentId, resolved)}
        onRead={(commentId) => void session.worksStore.markAnnotationRead(workId, commentId)}
      />
    </div>
  </div>
</div>

<style>
  /* The same rungs as WorkHeaderActions' verbs and overflow: 1.625rem on a
     desktop display, 1.5rem on a laptop display, a 2.5rem touch target on
     mobile. `:global` because the Select trigger is a child component and a
     scoped class would not reach it; the titlebar ancestor keeps it local. */
  .workspace-titlebar :global(.artifact-tool) {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    width: 1.625rem;
    height: 1.625rem;
    padding: 0;
    border-radius: 0.375rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .workspace-titlebar :global(.artifact-tool--labelled) {
    width: auto;
    padding: 0 0.4375rem;
  }
  .workspace-titlebar :global(.artifact-tool:hover) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  /* An armed tool or an open list reads as pressed. */
  .workspace-titlebar :global(.artifact-tool.is-active) {
    background: var(--solus-accent-soft);
    color: var(--solus-accent);
  }
  .workspace-titlebar :global(.artifact-tool:focus-visible) {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  @media (pointer: fine) and (min-width: 768px) {
    :global(html.is-laptop-display) .workspace-titlebar :global(.artifact-tool) {
      width: 1.5rem;
      height: 1.5rem;
    }
    :global(html.is-laptop-display) .workspace-titlebar :global(.artifact-tool--labelled) {
      width: auto;
    }
  }
  @media (max-width: 767px) {
    .workspace-titlebar :global(.artifact-tool) {
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 0.5rem;
    }
    .workspace-titlebar :global(.artifact-tool--labelled) {
      width: auto;
      padding: 0 0.75rem;
    }
  }
</style>
