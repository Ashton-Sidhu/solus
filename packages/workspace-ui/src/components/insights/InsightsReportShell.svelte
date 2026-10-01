<script lang="ts">
  import { MessageSquare as CommentsIcon, MessageSquarePlus as PinIcon } from "@lucide/svelte";
  import type { CommentPin } from "@solus/contracts/types";
  import { uuid } from "@solus/contracts/uuid";
  import { getSurfaceContext, presenceStore, sharesStore } from "../../contexts";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../ui/button";
  import ParentPageCrumb from "../ui/list-page/ParentPageCrumb.svelte";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import type { WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import ArtifactCommentLayer from "../artifact/ArtifactCommentLayer.svelte";
  import { setCommentViewer, workCommentViewer } from "../comments/lib/comment-viewer";
  import { openThreads } from "../comments/lib/thread";
  import { formatClock } from "./lib/format";
  import { buildTraceView } from "./lib/waterfall";
  import { traceExportJson } from "./lib/turn-analysis";
  import { parseTurnReport } from "./lib/turn-report";
  import TurnReadings from "./TurnReadings.svelte";

  /**
   * The pane surface for an `insights-report` work: the works header every
   * shell shares, over the turn page the Insights panel draws, read from the
   * readings captured at Share (docs/plans/cloud-sharing.md §4). A person the
   * report was shared with reads the same page its sharer did. The turn stayed
   * on its computer, so nothing here leads to another turn, the session, or the
   * task; comments pin to points on the page, as on an artifact.
   */
  interface Props {
    content: string;
    title: string;
    workId: string;
    onRename?: (title: string) => void;
    onDelete?: () => void;
    onDuplicate?: () => void | Promise<void>;
    onExport?: (request: WorkExportRequest) => void;
    hostIsRemote?: boolean;
    /** Leave the report for the Workspace page it lives in. */
    onOpenWorkspace?: () => void;
  }

  let { content, title, workId, onRename, onDelete, onDuplicate, onExport, hostIsRemote = false, onOpenWorkspace }: Props = $props();

  const report = $derived(parseTurnReport(content));
  const view = $derived(report ? buildTraceView(report.trace) : null);
  const root = $derived(view?.root ?? null);
  const prompts = $derived(new Map(Object.entries(report?.prompts ?? {})));
  const change = $derived(report?.patch == null ? ({ status: "missing" } as const) : { status: "ready" as const, patch: report.patch });
  /** The span a finding or an outcome line lands the waterfall on. */
  let openSpanId = $state<string | null>(null);

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
  function copyJson() {
    if (!report || !view || !root) return;
    void navigator.clipboard.writeText(traceExportJson(report.trace, view, root)).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    });
  }
  // The file the report is: the trace as the Insights panel exports it.
  const exportFormats: WorkExportFormat[] = [
    {
      extension: "json",
      label: "JSON",
      mimeType: "application/json",
      produce: () => (report && view && root ? { contents: traceExportJson(report.trace, view, root), encoding: "utf8" } : null),
    },
  ];

  // ─── Comments: pinned to points on the page, on the artifact's model ───
  const session = getSurfaceContext();
  const serverId = $derived(session.worksStore.hostFor(workId));
  setCommentViewer(() => workCommentViewer(session.worksStore.hostFor(workId), { kind: "work", id: workId }));
  const comments = $derived(session.worksStore.annotationComments(workId));
  const openCommentCount = $derived(openThreads(comments).length);
  const commentsReadOnly = $derived(!!serverId && sharesStore.listFor(serverId, { kind: "work", id: workId })?.callerRole === "viewer");

  let pinArmed = $state(false);
  let draftPin = $state<CommentPin | null>(null);
  let openThreadId = $state<string | null>(null);
  let commentListOpen = $state(false);
  const hasCommentOverlay = $derived(pinArmed || draftPin !== null || openThreadId !== null || commentListOpen);

  $effect(() => {
    const id = workId;
    void session.worksStore.loadAnnotations(id);
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

<div class="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="insights-report-shell">
  <div
    class="workspace-titlebar flex h-auto min-h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center gap-1.5 border-b border-[var(--hairline)] pl-[max(1rem,var(--solus-chrome-lead-inset,0px))] pr-[max(1rem,var(--solus-pane-chrome-inset,0px))] @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-1 @max-[30rem]/pane:pl-2"
  >
    {#if onOpenWorkspace}
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
        aria-label="Rename report"
        data-testid="rename-work-input"
      />
    {:else}
      <button
        type="button"
        class="min-w-0 flex-1 truncate border-0 bg-transparent text-left text-workspace-chrome font-medium text-(--solus-text-primary) enabled:cursor-text"
        onclick={startRename}
        disabled={!onRename}
        title={onRename ? "Rename" : undefined}
      >
        {title}
      </button>
    {/if}
    {#if report}
      <span class="shrink-0 text-workspace-chrome text-muted-foreground @max-[30rem]/pane:hidden">
        Captured {formatClock(report.capturedAt)}
      </span>
    {/if}
    {#if !commentsReadOnly}
      <Button
        variant="ghost"
        size="icon-sm"
        class="shrink-0 text-muted-foreground pointer-coarse:size-10 {pinArmed ? 'bg-(--solus-accent-soft) text-(--solus-accent)' : ''}"
        title="Comment on the report (⌥C)"
        aria-label="Comment on the report"
        aria-pressed={pinArmed}
        onclick={() => {
          pinArmed = !pinArmed;
          if (pinArmed) draftPin = null;
        }}
      >
        <PinIcon size={14} />
      </Button>
    {/if}
    {#if comments.length > 0}
      <Button
        variant="ghost"
        size="sm"
        class="h-7 shrink-0 gap-1 px-2 text-workspace-chrome text-muted-foreground pointer-coarse:h-10 {commentListOpen ? 'bg-(--solus-accent-soft) text-(--solus-accent)' : ''}"
        title={commentListOpen ? "Hide comments" : "Show comments"}
        aria-label={commentListOpen ? "Hide comments" : "Show comments"}
        aria-pressed={commentListOpen}
        onclick={() => (commentListOpen = !commentListOpen)}
      >
        <CommentsIcon size={14} />
        <span class="tabular-nums">{openCommentCount}</span>
      </Button>
    {/if}
    <WorkHeaderActions
      onStartRename={onRename ? startRename : undefined}
      {copied}
      copy={copyJson}
      {workId}
      {title}
      currentContent={content}
      {exportFormats}
      {onExport}
      {hostIsRemote}
      {onDelete}
      {onDuplicate}
    />
  </div>

  <!-- As on the Insights panel: the page is for reading recorded values, so
       its body opts back into text selection. -->
  <div class="@container min-h-0 flex-1 overflow-y-auto px-6 select-text" data-sb>
    {#if report && view && root}
      <div class="relative">
        <TurnReadings
          trace={report.trace}
          {view}
          {root}
          isLive={false}
          session={report.session}
          sessionName={report.sessionName}
          taskTitle={report.taskTitle}
          baselines={report.baselines}
          {prompts}
          {change}
          showResult={report.patch != null}
          loadRepoFiles={async () => null}
          spanId={openSpanId}
          onOpenSpan={(spanId) => (openSpanId = spanId)}
        />
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
          onReply={(commentId, text) => void session.worksStore.addAnnotationReply(workId, commentId, { id: uuid(), text, createdAt: Date.now() })}
          onResolve={(commentId, resolved) => void session.worksStore.setAnnotationResolved(workId, commentId, resolved)}
          onRead={(commentId) => void session.worksStore.markAnnotationRead(workId, commentId)}
        />
      </div>
    {:else}
      <div class="flex flex-col items-center gap-2 py-16 text-muted-foreground" role="status">
        <span class="text-insights-chrome">This report could not be read</span>
        <span class="text-insights-chrome">It was saved by a version of Solus this one does not read.</span>
      </div>
    {/if}
  </div>
</div>
