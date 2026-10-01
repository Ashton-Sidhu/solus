<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Work } from "@solus/contracts/types";
  import { getSurfaceContext, getClientShellContext, presenceStore, sharesStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@solus/client-core/server-connections";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import { Button } from "../ui/button";
  // Eager, unlike the shells they cover: these are what stand in for an async
  // boundary, so they cannot sit behind one themselves.
  import DocumentModalSkeleton from "../document-modal/DocumentModalSkeleton.svelte";
  import DiagramShellSkeleton from "../diagram/DiagramShellSkeleton.svelte";
  // Eager: the sandbox it wraps is already in the conversation bundle.
  import ArtifactShell from "../artifact/ArtifactShell.svelte";
  import SaveFilePicker from "../pickers/SaveFilePicker.svelte";
  import RouteLoadError from "../ui/RouteLoadError.svelte";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import { storedExportExtension, type WorkExportRequest } from "./lib/work-export";
  import { holdWorkForPane, unavailableMessage, type WorkPaneHold } from "./lib/work-draft.svelte";
  import { exportFileName } from "../pickers/lib/export-file-name";
  import type { FilePayload } from "../diagram/lib/diagram-export";
  import { toasts } from "../../lib/toasts";
  import { recentCommentAuthors, type MentionScope } from "../mentions/lib/mentions";
  import { provideMentionScope } from "../mentions/lib/mention-scope.svelte";
  import { setWorkPaneContext } from "./lib/work-pane-context";
  import { isLiveEditable, type WorkLiveLease } from "../../contexts/works/work-live.store.svelte";
  import { liveCaretUser, type LiveEditorBinding } from "../editor/lib/live-editor";

  let { params, paneId }: RouteSurfaceProps<"work"> = $props();

  const session = getSurfaceContext();
  const pane = paneActions(() => paneId);
  const shell = getClientShellContext();

  const workMetadata = $derived(session.worksStore.get(params.workId));
  // The store's host for the work wins over the route's: after a Share the
  // route still names the machine, the store the organization's service.
  const workServerId = $derived(session.worksStore.hostFor(params.workId) ?? params.serverId ?? null);
  const sess = $derived(session.activeSession);

  // One hold per open work id: the store's shared, subscribed saved record, and
  // this pane's own draft over it. Local and cloud works take the same path.
  let hold = $state.raw<WorkPaneHold | null>(null);
  // Leaving the work ends editing on purpose; the host would clear it anyway.
  $effect(() => {
    const workId = params.workId;
    return () => presenceStore.stopEditing(untrack(() => workServerId), workId);
  });
  $effect(() => {
    const workId = params.workId;
    const serverIdHint = params.serverId;
    return untrack(() => {
      const next = holdWorkForPane(session.worksStore, workId, serverIdHint, signalLiveUpdate);
      hold = next;
      return () => next.close();
    });
  });
  const openWork = $derived(hold?.work ?? null);
  const draft = $derived(hold?.draft ?? null);
  // The editor mounts once the pane has a saved body. Manifest entries have
  // none, and an empty editor must not stand in while the read is pending.
  const work = $derived(draft?.loaded ? (workMetadata ?? session.worksStore.savedWork(params.workId) ?? null) : null);

  // Live editing (work review plan, phase 3b): documents and diagrams are
  // edited in a shared doc on the work's host. A host from before live editing
  // answers `unsupported`, and the pane keeps saving whole bodies.
  const liveType = $derived.by(() => {
    const type = work?.type;
    if (type !== "doc" && type !== "diagram") return null;
    return isLiveEditable(type, work?.mirroredDoc?.provider === "gdrive") ? type : null;
  });
  let liveLease = $state.raw<WorkLiveLease | null>(null);
  $effect(() => {
    const serverId = workServerId;
    const workId = params.workId;
    const type = liveType;
    if (!serverId || !type) return;
    return untrack(() => {
      const lease = session.worksStore.live.acquire(serverId, workId, type, () => presenceStore.noteEditing(serverId, workId));
      liveLease = lease;
      return () => {
        lease.release();
        if (liveLease === lease) liveLease = null;
      };
    });
  });
  const live = $derived(liveLease?.live ?? null);
  const liveActive = $derived(!!live && live.connection !== "unsupported");
  // The editor mounts once the shared doc has content, from the device or the host.
  const liveReady = $derived(!liveType || (!!live && (!liveActive || live.ready)));
  const liveBinding = $derived<LiveEditorBinding | null>(
    live && liveActive ? { live, user: liveCaretUser(workServerId ? sharesStore.identities.get(workServerId)?.user ?? null : null) } : null,
  );

  const callerRole = $derived(workServerId ? sharesStore.listFor(workServerId, { kind: "work", id: params.workId })?.callerRole ?? null : null);
  // A commenter reads and reviews; only an editor changes the body.
  const viewerReadOnly = $derived(callerRole === "viewer" || callerRole === "commenter");
  // The host deletes a work for its owner alone; a Local work has no list.
  const canDelete = $derived(callerRole === null || callerRole === "owner");
  $effect(() => {
    const serverId = workServerId;
    const workId = params.workId;
    if (serverId) untrack(() => { void sharesStore.load(serverId, { kind: "work", id: workId }); });
  });

  // Every work surface's composers mention the people of the work's
  // organization; a Local work has none (plan 004 item 13).
  const mentionScope = $derived.by((): MentionScope | null => {
    const meta = work ?? workMetadata;
    if (!workServerId || !meta) return null;
    return {
      serverId: workServerId,
      organizationId: meta.organizationId,
      resource: { kind: "work", id: params.workId },
      title: meta.title,
      recentUserIds: recentCommentAuthors(session.worksStore.annotationComments(params.workId)),
    };
  });
  provideMentionScope(() => mentionScope);

  let discardingShell = false;
  async function saveCopy(updates: Partial<Pick<Work, "title" | "preview" | "content">>) {
    // DiagramShell flushes its draft on teardown. An explicit reload must not
    // save that discarded draft over the version we just loaded.
    if (discardingShell || !draft) return;
    // The host writes a live doc's body; only a rename is the pane's to save.
    if (liveActive && updates.content !== undefined) return;
    if (openWork?.status === "unavailable") throw new Error(unavailableMessage(openWork.unavailableReason));
    const workId = params.workId;
    // A save follows an edit by a moment: the roster says who is editing.
    if (updates.content !== undefined) presenceStore.noteEditing(workServerId, workId);
    await draft.save(updates, (write, base) => session.worksStore.save(workId, write, base));
  }

  /** Drop this pane's edits and show the saved copy. */
  async function reloadSavedCopy() {
    draft?.discard();
    discardingShell = true;
    renderKey++;
    try { await tick(); } finally { discardingShell = false; }
  }

  const originalSessionMeta = $derived.by(() => {
    if (!work) return null;
    // Candidate sessions, most-recent-linked first, then the legacy origin id.
    const candidates = [
      ...[...(work.sessionIds ?? [])].reverse(),
      ...(work.sessionId ? [work.sessionId] : []),
    ];
    for (const sid of candidates) {
      const sess = session.sessionForAgentSession(sid, session.worksStore.hostFor(work.id) ?? undefined);
      if (sess) {
        return {
          sessionId: sess.agentSessionId || "",
          title: sess.title || "Unnamed session",
          provider: sess.run.provider || "claude-code",
          cwd: sess.run.workingDirectory,
        };
      }
    }
    return null;
  });

  // A clean editor takes each newer saved body through its `content` prop; a
  // remount (renderKey) happens only on an explicit reload, a restore, or a
  // retry after a failed shell load.
  let renderKey = $state(0);
  // Briefly true right after a clean editor accepted someone else's save, to
  // play the "Updated live" signal (edge-glow + ephemeral pill). Cleared on a
  // timer so the animation runs once per accepted version.
  let justUpdated = $state(false);
  // The save picker in flight: the file a shell encoded, or a `null` payload
  // when the host writes the stored work itself.
  let exportDraft = $state<{ fileName: string; payload: FilePayload | null } | null>(null);
  let justUpdatedTimer: ReturnType<typeof setTimeout> | null = null;

  function signalLiveUpdate() {
    // A live doc shows every edit as it happens; the saved body it projects is not news.
    if (liveActive) return;
    if (justUpdatedTimer) clearTimeout(justUpdatedTimer);
    justUpdated = true;
    justUpdatedTimer = setTimeout(() => {
      justUpdated = false;
    }, 1900);
  }

  $effect(() => () => {
    if (justUpdatedTimer) clearTimeout(justUpdatedTimer);
  });

  /** Where the save picker opens: the work's own project, when it has one. */
  const exportStartPath = $derived(
    sess?.run.gitContext?.worktreePath ?? sess?.run.gitContext?.repoRoot ?? sess?.run.workingDirectory ?? "",
  );
  // Saving writes to the host's filesystem. When that host is this very machine
  // there is nothing a browser download would add; when it is not, or there is
  // no project to save into (a share link), downloading is the only way to get
  // the file onto the device the user is holding.
  const hostIsRemote = $derived(!exportStartPath || (!!sess && !hostPolicy.isClientMachine(sess.run.serverId)));

  // The crumb's way back: leave this pane, then show the page the work is a
  // row on — the same two steps the automation builder takes.
  function openWorkspacePage() {
    pane.close();
    session.openFolio();
  }

  function handleClose() {
    session.closeWork(paneId);
  }

  function handleOpenChat(mode: "resume" | "new") {
    shell.openResource({ kind: "chat", workId: params.workId, mode });
  }

  // A guest shell has nowhere for these to lead, so the surfaces offer no way there.
  // A duplicate lands in the sharer's Workspace, which a guest cannot open.
  const canOpenWorkspace = $derived(shell.canOpenResource("workspace"));
  const canOpenChat = $derived(shell.canOpenResource("chat"));

  function handleRename(newTitle: string) {
    void saveCopy({ title: newTitle }).catch((error) => toasts.error(error.message));
  }

  // The header's History and Review name the body this pane is based on.
  setWorkPaneContext({
    contentVersion: async () => {
      if (liveActive) await openWork?.refresh();
      return draft?.baseContentVersion ?? 0;
    },
    isDirty: () => !!draft?.dirty,
    canEdit: () => !viewerReadOnly && workMetadata?.mirroredDoc?.provider !== "gdrive",
    restoreRevision: async (revisionId) => {
      if (!draft) return;
      // Live: the reader sees every edit as it lands; read the body the host
      // wrote from them, so the restore names that version.
      if (liveActive) await openWork?.refresh();
      await session.worksStore.restoreRevision(params.workId, revisionId, draft.baseContentVersion);
      await reloadSavedCopy();
    },
  });

  function handleDelete() {
    const target = session.worksStore.get(params.workId);
    if (!target) return;
    handleClose();
    session.requestWorkDelete(target);
  }

  async function handleDuplicate() {
    const duplicated = await session.worksStore.duplicate(params.workId);
    session.openWork(duplicated.id);
    requestInputFocus();
  }

  function handleExport(request: WorkExportRequest) {
    if (!work || !exportStartPath) return;
    exportDraft = "payload" in request
      ? request
      : { fileName: exportFileName(work.title, storedExportExtension(work.type)), payload: null };
  }

  /** The work's host writes its stored content to the path the picker chose. */
  async function exportStoredTo(path: string) {
    const result = await session.worksStore.exportToPath(params.workId, path);
    toasts.success("Exported", { description: result.path });
  }
</script>

{#snippet liveBadge()}
  <div class="work-live-badge" role="status" aria-label="Work updated live">
    <span class="work-live-badge__dot"></span>
    Updated live
  </div>
{/snippet}

<!-- One status line for the saved copy: gone, changed under unsaved edits,
     waiting on the host, or not refreshed. The draft always stays on screen. -->
{#snippet savedCopyStatus(message: string, action: { label: string; testId: string; run: () => void } | null)}
  <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--solus-accent-border) bg-(--solus-accent-light) px-4 py-2 text-workspace-chrome" role="status">
    <span class="min-w-0">{message}</span>
    {#if action}
      <Button
        variant="outline"
        size="xs"
        class="shrink-0 pointer-coarse:min-h-11"
        data-testid={action.testId}
        disabled={openWork?.refreshing}
        onclick={action.run}
      >
        {action.label}
      </Button>
    {/if}
  </div>
{/snippet}

{#if work && draft}
  <div class="flex h-full flex-col min-h-0 work-live-host" class:work-live-pulse={justUpdated}>
    {#if openWork?.status === "unavailable"}
      {@render savedCopyStatus(unavailableMessage(openWork.unavailableReason), { label: "Check again", testId: "work-check-again", run: () => openWork?.retry() })}
    {:else if draft.conflict}
      {@render savedCopyStatus("This work changed since you started editing. Your edits are not saved.", { label: "Discard edits and reload", testId: "work-refresh", run: () => void reloadSavedCopy() })}
    {:else if openWork?.reconnecting}
      {@render savedCopyStatus("Reconnecting to this work's host. Your edits are kept.", null)}
    {:else if openWork?.error}
      {@render savedCopyStatus("Could not refresh this work. You are viewing the last saved copy.", { label: openWork.refreshing ? "Retrying…" : "Retry", testId: "work-retry-refresh", run: () => openWork?.retry() })}
    {/if}
    {#if justUpdated}
      {@render liveBadge()}
    {/if}
    {#key `${work.id}-${renderKey}-${liveBinding ? "live" : "saved"}-${liveReady}`}
      <div class="flex-1 min-h-0">
        {#if work.type === "diagram" && viewerReadOnly}
          {#await import("../diagram/DiagramPreview.svelte") then previewModule}
            <previewModule.default content={draft.content} title={work.title} />
          {/await}
        {:else if work.type === "diagram" && !liveReady}
          <DiagramShellSkeleton />
        {:else if work.type === "diagram"}
          {#await import("../diagram/DiagramShell.svelte")}
            <DiagramShellSkeleton />
          {:then diagramModule}
            {@const DiagramShell = diagramModule.default}
            <!-- See the note on the document branch below: workId is read from
                 DOM handlers that can outlive `work` by a tick. -->
            <DiagramShell
              content={draft.content}
              title={work.title}
              workId={work?.id}
              onSave={async (c) => {
                await saveCopy({ content: c });
              }}
              onDirtyChange={(d) => draft?.setDirty(d)}
              onClose={handleClose}
              onOpenWorkspace={canOpenWorkspace ? openWorkspacePage : undefined}
              onOpenChat={canOpenChat ? handleOpenChat : undefined}
              {originalSessionMeta}
              onRename={viewerReadOnly ? undefined : handleRename}
              onDelete={canDelete ? handleDelete : undefined}
              onDuplicate={canOpenWorkspace ? handleDuplicate : undefined}
              onExport={exportStartPath ? handleExport : undefined}
              {hostIsRemote}
              live={liveBinding}
            />
          {:catch error}
            <RouteLoadError
              {error}
              compact
              onRetry={() => (renderKey += 1)}
            />
          {/await}
        {:else if work.type === "insights-report"}
          {#await import("../insights/InsightsReportShell.svelte")}
            <DocumentModalSkeleton inline title={work.title} />
          {:then reportModule}
            <reportModule.default
              content={draft.content}
              title={work.title}
              workId={work.id}
              onOpenWorkspace={canOpenWorkspace ? openWorkspacePage : undefined}
              onRename={viewerReadOnly ? undefined : handleRename}
              onDelete={canDelete ? handleDelete : undefined}
              onDuplicate={canOpenWorkspace ? handleDuplicate : undefined}
              onExport={exportStartPath ? handleExport : undefined}
              {hostIsRemote}
            />
          {:catch error}
            <RouteLoadError
              {error}
              compact
              onRetry={() => (renderKey += 1)}
            />
          {/await}
        {:else if work.type === "artifact"}
          <ArtifactShell
            content={draft.content}
            title={work.title}
            workId={work.id}
            onClose={handleClose}
            onOpenWorkspace={canOpenWorkspace ? openWorkspacePage : undefined}
            onOpenChat={canOpenChat ? handleOpenChat : undefined}
            {originalSessionMeta}
            onRename={viewerReadOnly ? undefined : handleRename}
            onDelete={canDelete ? handleDelete : undefined}
            onDuplicate={canOpenWorkspace ? handleDuplicate : undefined}
            onExport={exportStartPath ? handleExport : undefined}
            {hostIsRemote}
          />
        {:else if !liveReady}
          <DocumentModalSkeleton inline title={work.title} />
        {:else}
          {#await import("../document-modal/DocumentModal.svelte")}
            <DocumentModalSkeleton inline title={work.title} />
          {:then documentModule}
            {@const DocumentModal = documentModule.default}
            <!-- workId is optional-chained on purpose: props compile to lazy
                 getters, so a DOM handler still attached during teardown (the
                 comment layer's pointerover) can re-read it after `work` has
                 gone null. Consumers already treat a missing workId as "no
                 comments". `document` stays eager — resolving it to empty
                 mid-teardown would push a blank doc into the editor. -->
            <DocumentModal
              document={{ title: work.title, content: draft.content }}
              workId={work?.id}
              onSave={async (c) => {
                await saveCopy({ content: c });
              }}
              onDirtyChange={(d) => draft?.setDirty(d)}
              onClose={handleClose}
              onOpenWorkspace={canOpenWorkspace ? openWorkspacePage : undefined}
              inline
              minimizeOutline={!pane.isLeading}
              onOpenChat={canOpenChat ? handleOpenChat : undefined}
              {originalSessionMeta}
              onRename={viewerReadOnly ? undefined : handleRename}
              onDelete={canDelete ? handleDelete : undefined}
              onDuplicate={canOpenWorkspace ? handleDuplicate : undefined}
              onExport={exportStartPath ? handleExport : undefined}
              {hostIsRemote}
              live={liveBinding}
            />
          {:catch error}
            <RouteLoadError
              {error}
              compact
              onRetry={() => (renderKey += 1)}
            />
          {/await}
        {/if}
      </div>
    {/key}
    <!-- After the content: the shell toolbars above are window drag regions,
         and a drag rect later in the DOM would re-cover this cluster's no-drag
         holes. A guest shell has no pane row to close into, so it gets none. -->
    {#if canOpenWorkspace}
      <PaneChrome
        onClose={handleClose}
        onOpenInSplit={shell.hasCompanionPanes ? pane.moveAcross : undefined}
        onToggleMaximize={shell.hasCompanionPanes && workMetadata?.type !== "artifact" ? pane.toggleMaximize : null}
        maximized={pane.maximized}
        isLeading={pane.isLeading}
        closeLabel={work.type === "diagram"
          ? "Close diagram"
          : work.type === "artifact"
            ? "Close artifact"
            : work.type === "insights-report"
              ? "Close report"
              : "Close document"}
        closeTestId={work.type === "doc" || work.type === "slides" ? "document-modal-close" : undefined}
      />
    {/if}
  </div>
{:else if openWork?.status === "unavailable"}
  <RouteLoadError error={new Error(unavailableMessage(openWork.unavailableReason))} compact onRetry={() => openWork?.retry()} />
{:else if openWork?.status === "error"}
  <RouteLoadError
    error={new Error(openWork.error ?? "This work could not be loaded from its host.")}
    compact
    onRetry={() => openWork?.retry()}
  />
{:else}
  {#if workMetadata?.type === "diagram"}
    <DiagramShellSkeleton />
  {:else}
    <DocumentModalSkeleton inline title={workMetadata?.title} />
  {/if}
{/if}

{#if !work && canOpenWorkspace}
  <PaneChrome
    onClose={handleClose}
    onOpenInSplit={shell.hasCompanionPanes ? pane.moveAcross : undefined}
    onToggleMaximize={shell.hasCompanionPanes && workMetadata?.type !== "artifact" ? pane.toggleMaximize : null}
    maximized={pane.maximized}
    isLeading={pane.isLeading}
    closeLabel="Close loading work"
  />
{/if}

{#if exportDraft && exportStartPath && sess}
  <SaveFilePicker
    open
    onClose={() => {
      exportDraft = null;
      requestInputFocus();
    }}
    api={serverConnections.apiFor(sess.run.serverId)}
    serverId={sess.run.serverId}
    ctx={session.ctxForDirectory(exportStartPath)}
    initialPath={exportStartPath}
    fileName={exportDraft.fileName}
    content={exportDraft.payload?.contents}
    encoding={exportDraft.payload?.encoding}
    onPick={exportDraft.payload ? undefined : exportStoredTo}
    title={exportDraft.payload ? undefined : "Export"}
  />
{/if}

<style>
  /* ─── Live-update signal: edge-glow sweep + ephemeral "Updated live" pill ─── */
  .work-live-host {
    position: relative;
  }
  .work-live-pulse::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;
    box-shadow: inset 0 0 0 0.125rem var(--solus-accent);
    opacity: 0;
    animation: work-live-glow 1100ms var(--ease-premium);
  }
  @keyframes work-live-glow {
    0% {
      opacity: 0;
    }
    16% {
      opacity: 0.85;
    }
    100% {
      opacity: 0;
    }
  }

  .work-live-badge {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 30;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border-radius: 9999px;
    background: var(--solus-accent);
    color: var(--solus-on-accent, #fff);
    font-size: var(--text-xs);
    font-weight: 500;
    pointer-events: none;
    box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.18);
    animation: work-live-badge 1900ms var(--ease-premium) forwards;
  }
  @keyframes work-live-badge {
    0% {
      opacity: 0;
      transform: translateY(-0.375rem) scale(0.96);
    }
    10% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    82% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    100% {
      opacity: 0;
      transform: translateY(-0.25rem) scale(0.98);
    }
  }
  .work-live-badge__dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: currentColor;
    animation: work-live-dot 1s ease-in-out infinite;
  }
  @keyframes work-live-dot {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .work-live-pulse::after {
      animation-duration: 1ms;
    }
    .work-live-badge {
      animation: work-live-badge-static 1900ms steps(1, end) forwards;
    }
    .work-live-badge__dot {
      animation: none;
    }
  }
  @keyframes work-live-badge-static {
    0%,
    82% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
</style>
