<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@client-core/server-connections";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  // Eager, unlike the shells they cover: these are what stand in for an async
  // boundary, so they cannot sit behind one themselves.
  import DocumentModalSkeleton from "../document-modal/DocumentModalSkeleton.svelte";
  import DiagramShellSkeleton from "../diagram/DiagramShellSkeleton.svelte";
  import SaveToProjectPicker from "../pickers/SaveToProjectPicker.svelte";
  import { projectSourceFileName } from "../pickers/lib/project-source-file";

  let { params, paneId }: RouteSurfaceProps<"work"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(paneId);

  const work = $derived(session.worksStore.get(params.workId));
  const sess = $derived(session.sessionFor(session.activeTabId));

  const originalSessionMeta = $derived.by(() => {
    if (!work) return null;
    // Candidate sessions, most-recent-linked first, then the legacy origin id.
    const candidates = [
      ...[...(work.sessionIds ?? [])].reverse(),
      ...(work.sessionId ? [work.sessionId] : []),
    ];
    for (const sid of candidates) {
      const openTab = session.tabIdForAgentSession(sid, session.worksStore.hostFor(work.id) ?? undefined);
      if (openTab) {
        const sess = session.sessionFor(openTab);
        if (sess) {
          return {
            sessionId: sess.agentSessionId || "",
            title: sess.title || "Unnamed session",
            provider: sess.run.provider || "claude-code",
            cwd: sess.run.workingDirectory,
          };
        }
      }
    }
    return null;
  });

  // ─── Live-refresh + dirty-conflict for the active work shell ───
  // The shells parse their content once at mount, so an agent update is applied
  // by remounting (bumping renderKey) — but only when the shell has no unsaved
  // edits. If it's dirty, we surface a refresh pill instead of clobbering.
  let shellDirty = $state(false);
  let conflict = $state(false);
  let renderKey = $state(0);
  // Briefly true right after a clean live-refresh, to play the "Updated live"
  // signal (edge-glow + ephemeral pill). Cleared on a timer so the animation
  // runs once per agent update.
  let justUpdated = $state(false);
  let saveToProjectDraft = $state<{ fileName: string; content: string } | null>(null);
  let justUpdatedTimer: ReturnType<typeof setTimeout> | null = null;
  let trackedWorkId: string | null = null;
  let trackedAgentRev = 0;

  const agentRev = $derived(session.worksStore.agentRevisions[params.workId] ?? 0);

  function signalLiveUpdate() {
    if (justUpdatedTimer) clearTimeout(justUpdatedTimer);
    justUpdated = true;
    justUpdatedTimer = setTimeout(() => {
      justUpdated = false;
    }, 1900);
  }

  $effect(() => {
    const workId = params.workId;
    const rev = agentRev;
    if (workId !== trackedWorkId) {
      trackedWorkId = workId;
      trackedAgentRev = rev;
      shellDirty = false;
      conflict = false;
      justUpdated = false;
      return;
    }
    if (rev !== trackedAgentRev) {
      trackedAgentRev = rev;
      if (shellDirty) conflict = true;
      else {
        renderKey++;
        signalLiveUpdate();
      }
    }
  });

  $effect(() => () => {
    if (justUpdatedTimer) clearTimeout(justUpdatedTimer);
  });

  const promoteTargetRoot = $derived(
    sess?.run.gitContext?.worktreePath ?? sess?.run.gitContext?.repoRoot ?? sess?.run.workingDirectory ?? "",
  );

  function refreshFromAgent() {
    conflict = false;
    shellDirty = false;
    renderKey++;
  }

  function handleOpenChat(mode: "resume" | "new") {
    void session.openChatForWork(params.workId, mode);
  }

  function handleRename(newTitle: string) {
    void session.worksStore.save(params.workId, { title: newTitle });
  }

  async function handleRevert() {
    const reverted = await session.worksStore.revert(
      params.workId,
      sess?.run.workingDirectory,
    );
    if (!reverted) return;
    // Reload the shell off the reverted content (shells parse content at mount).
    shellDirty = false;
    conflict = false;
    renderKey++;
  }

  function handleDelete() {
    const target = session.worksStore.get(params.workId);
    if (!target) return;
    pane.close();
    session.requestWorkDelete(target);
  }

  async function handleDuplicate() {
    const duplicated = await session.worksStore.duplicate(params.workId);
    session.openWork(duplicated.id);
    requestInputFocus();
  }

  function handleSaveToProject(content: string) {
    if (!work || !promoteTargetRoot) return;
    saveToProjectDraft = {
      fileName: projectSourceFileName(work.title, work.type),
      content,
    };
  }
</script>

{#snippet liveBadge()}
  <div class="work-live-badge" role="status" aria-label="Work updated live by the agent">
    <span class="work-live-badge__dot"></span>
    Updated live
  </div>
{/snippet}

{#snippet refreshPill()}
  <div class="work-refresh-banner" role="status">
    <span class="work-refresh-banner__text">The agent updated this work.</span>
    <button
      type="button"
      class="work-refresh-banner__btn"
      data-testid="work-refresh"
      onclick={refreshFromAgent}
    >
      Refresh
    </button>
  </div>
{/snippet}

{#if work}
  <div class="flex h-full flex-col min-h-0 work-live-host" class:work-live-pulse={justUpdated}>
    {#if conflict}
      {@render refreshPill()}
    {/if}
    {#if justUpdated}
      {@render liveBadge()}
    {/if}
    {#key `${work.id}-${renderKey}`}
      <div class="flex-1 min-h-0">
        {#if work.type === "diagram"}
          {#await import("../diagram/DiagramShell.svelte")}
            <DiagramShellSkeleton />
          {:then diagramModule}
            {@const DiagramShell = diagramModule.default}
            <!-- See the note on the document branch below: workId is read from
                 DOM handlers that can outlive `work` by a tick. -->
            <DiagramShell
              content={work.content ?? ""}
              title={work.title}
              workId={work?.id}
              onSave={async (c) => {
                await session.worksStore.save(work.id, { content: c });
              }}
              onDirtyChange={(d) => {
                shellDirty = d;
              }}
              onClose={pane.close}
              onOpenChat={handleOpenChat}
              {originalSessionMeta}
              onRename={handleRename}
              onRevert={handleRevert}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              workStorage={work.storage}
              onSaveToProject={promoteTargetRoot ? handleSaveToProject : undefined}
            />
          {/await}
        {:else}
          {#await import("../document-modal/DocumentModal.svelte")}
            <DocumentModalSkeleton inline title={work.title} workStorage={work.storage} />
          {:then documentModule}
            {@const DocumentModal = documentModule.default}
            <!-- workId is optional-chained on purpose: props compile to lazy
                 getters, so a DOM handler still attached during teardown (the
                 comment layer's pointerover) can re-read it after `work` has
                 gone null. Consumers already treat a missing workId as "no
                 comments". `document` stays eager — resolving it to empty
                 mid-teardown would push a blank doc into the editor. -->
            <DocumentModal
              document={{ title: work.title, content: work.content }}
              workId={work?.id}
              docType={work.type}
              onSave={async (c) => {
                await session.worksStore.save(work.id, { content: c });
              }}
              onDirtyChange={(d) => {
                shellDirty = d;
              }}
              onClose={pane.close}
              inline
              minimizeOutline={!pane.isLeading}
              onOpenChat={handleOpenChat}
              {originalSessionMeta}
              onRename={handleRename}
              onRevert={handleRevert}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              workStorage={work.storage}
              onSaveToProject={promoteTargetRoot ? handleSaveToProject : undefined}
            />
          {/await}
        {/if}
      </div>
    {/key}
    <!-- After the content: the shell toolbars above are window drag regions,
         and a drag rect later in the DOM would re-cover this cluster's no-drag
         holes. -->
    <PaneChrome
      onClose={pane.close}
      onOpenInSplit={pane.moveAcross}
      onToggleMaximize={pane.toggleMaximize}
      maximized={pane.maximized}
      isLeading={pane.isLeading}
      closeLabel={work.type === "diagram" ? "Close diagram" : "Close document"}
      closeTestId={work.type === "diagram" ? undefined : "document-modal-close"}
    />
  </div>
{/if}

{#if saveToProjectDraft && promoteTargetRoot && sess}
  <SaveToProjectPicker
    open
    onClose={() => {
      saveToProjectDraft = null;
      requestInputFocus();
    }}
    api={serverConnections.apiFor(sess.run.serverId)}
    serverId={sess.run.serverId}
    ctx={session.ctxForDirectory(promoteTargetRoot)}
    projectRoot={promoteTargetRoot}
    fileName={saveToProjectDraft.fileName}
    content={saveToProjectDraft.content}
  />
{/if}

<style>
  .work-refresh-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    flex-shrink: 0;
    background: var(--solus-accent-light);
    border-bottom: 0.0625rem solid var(--solus-accent-border);
  }
  .work-refresh-banner__text {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--solus-text-primary);
  }
  .work-refresh-banner__btn {
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 0.25rem 0.75rem;
    border-radius: 0.375rem;
    border: 0.0625rem solid var(--solus-accent-border);
    background: var(--solus-accent);
    color: var(--solus-on-accent, #fff);
    cursor: pointer;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  .work-refresh-banner__btn:hover {
    opacity: 0.85;
  }
  .work-refresh-banner__btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }

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
