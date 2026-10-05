<script lang="ts">
  import { MessageSquare as CommentsIcon, MessageSquarePlus as PinIcon } from "@lucide/svelte";
  import type { CommentPin } from "@solus/contracts/types";
  import type { TurnFlagKind } from "@solus/contracts/observability-types";
  import { uuid } from "@solus/contracts/uuid";
  import { getSurfaceContext, presenceStore, sharesStore } from "../../contexts";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../ui/button";
  import { SubPageCrumbLine } from "../ui/list-page";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import type { WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import ArtifactCommentLayer from "../artifact/ArtifactCommentLayer.svelte";
  import { setCommentViewer, workCommentViewer } from "../comments/lib/comment-viewer";
  import { openThreads } from "../comments/lib/thread";
  import { sameUser } from "@solus/contracts/user";
  import { toasts } from "../../lib/toasts";
  import { formatClock } from "./lib/format";
  import { buildTraceView } from "./lib/waterfall";
  import { traceExportJson } from "./lib/turn-analysis";
  import { parseTurnReport } from "./lib/turn-report";
  import { flagChoice, flagColor, markGroups } from "./lib/turn-flags";
  import TurnFlagMenu from "./TurnFlagMenu.svelte";
  import TurnReadings from "./TurnReadings.svelte";

  /**
   * The pane surface for an `insights-report` work: the works header every
   * shell shares, over the turn page the Insights panel draws, read from the
   * readings captured at Share (docs/plans/cloud-sharing.md §4). A person the
   * report was shared with reads the same page its sharer did. The turn stayed
   * on its computer, so nothing here leads to another turn, the session, or the
   * task; comments pin to points on the page, as on an artifact. Each reader
   * who may comment keeps their own mark on the turn; a viewer reads the marks.
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

  // ─── Marks: each reader's own, beside the comments ───
  // A mark is a reaction like a comment, so whoever may comment may mark.
  const marks = $derived(session.worksStore.annotationMarks(workId));
  const selfId = $derived(serverId ? presenceStore.currentUserId(serverId) : null);
  const ownMark = $derived(selfId ? (marks.find((mark) => sameUser(mark.by.id, selfId)) ?? null) : null);
  const otherMarks = $derived(markGroups(marks.filter((mark) => mark !== ownMark)));

  function setMark(mark: { kind: TurnFlagKind; note: string } | null): void {
    void session.worksStore.setAnnotationMark(workId, mark).catch(() => toasts.error("Could not save the mark"));
  }

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

{#snippet titleControl()}
  {#if renaming}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="h-7 min-w-24 max-w-96 rounded-md border border-(--solus-accent-border) bg-(--solus-surface-hover) px-[7px] text-workspace-chrome text-foreground outline-none pointer-coarse:h-9"
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
      class="flex h-7 min-w-0 max-w-96 items-center truncate rounded border-0 bg-transparent px-[7px] text-left text-foreground enabled:cursor-text pointer-coarse:h-9"
      onclick={startRename}
      disabled={!onRename}
      title={onRename ? "Rename" : title}
    >
      <span class="truncate">{title}</span>
    </button>
  {/if}
{/snippet}

{#snippet headerActions()}
  {#if report}
    <span class="shrink-0 text-muted-foreground @max-[30rem]/pane:hidden">
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
{/snippet}

<!-- The turn's own verbs, beside its prompt as on the Insights panel. Only
     the mark applies here: the turn's session and task stayed on its computer.
     The control is the reader's own mark; the others' marks follow it. -->
{#snippet turnActions()}
  {#each otherMarks as group (group.kind)}
    {@const choice = flagChoice(group.kind)}
    <span
      class="flex h-6.5 shrink-0 items-center gap-1 rounded-full px-2 text-insights-chrome tabular-nums pointer-coarse:h-10"
      style="color:{flagColor(group.kind)}"
      title={group.title}
      aria-label={group.title}
    >
      <choice.icon class="size-4" strokeWidth={1.5} aria-hidden="true" />
      {group.count}
    </span>
  {/each}
  <TurnFlagMenu
    flag={ownMark}
    readOnly={commentsReadOnly}
    onSet={(kind, note) => setMark({ kind, note })}
    onClear={() => setMark(null)}
  />
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="insights-report-shell">
  <!-- The same band the Insights turn page draws, so the shared page reads
       as that page: the way back, the report's name, and its actions. -->
  <SubPageCrumbLine
    page="folio"
    onOpenPage={onOpenWorkspace}
    leafControl={titleControl}
    actions={headerActions}
    divided={false}
  />

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
          showResult
          loadRepoFiles={async () => null}
          spanId={openSpanId}
          actions={turnActions}
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
