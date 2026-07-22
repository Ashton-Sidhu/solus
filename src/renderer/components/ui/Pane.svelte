<script lang="ts">
  import type { Component } from 'svelte'
  import {
    isMovableContent,
    isPageContent,
    type PageKind,
    type PaneContent,
    type PaneSlot,
  } from '../../contexts/pane-view.store.svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import { getPlanStore } from '../../contexts/plan.store.svelte'
  import { requestInputFocus } from '../../lib/inputFocus'

  // Keep every non-conversation surface behind an actual async boundary. Pane
  // itself is part of the editor's common module graph, but these views are not
  // needed until their corresponding content enters a slot.
  const PAGE_LOADERS: Record<PageKind, () => Promise<{ default: Component }>> = {
    tasks: () => import('../tasks/TasksPage.svelte'),
    prs: () => import('../prs/PrsPage.svelte'),
    'review-mode': () => import('../review-mode/ReviewModeHost.svelte'),
    settings: () => import('../settings/SettingsPage.svelte'),
    'plans-gallery': () => import('../plan/PlanGallery.svelte'),
    'folio-gallery': () => import('../artifact/FolioGallery.svelte'),
    'automations-list': () => import('../automations/AutomationsPage.svelte'),
  }

  interface Props {
    content: PaneContent
    slot: PaneSlot
    onToggleSecondaryMaximize?: () => void
    onAttachFile?: (tabId?: string) => void | Promise<void>
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null
    onDesignMode?: ((tabId?: string) => void | Promise<void>) | null
  }

  let {
    content,
    slot,
    onToggleSecondaryMaximize,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: Props = $props()

  const session = getWorkspaceContext()
  const planStore = getPlanStore()
  const panes = session.panes

  const activePlan = $derived.by(() => {
    if (content.kind !== 'plan') return null
    const planId = content.planId
    const plan = planId ? planStore.get(planId) : planStore.previewPlan
    if (!plan?.content.trim()) return null
    return plan
  })

  const activeWork = $derived.by(() => {
    if (content.kind !== 'work') return null
    return session.worksStore.get(content.workId)
  })

  // The builder seeds its drafts from this prop at mount, so for a saved
  // automation we wait until the store has it (it loads on open) before
  // rendering, and key the block on the id so it remounts once resolved.
  const activeAutomation = $derived.by(() => {
    if (content.kind !== 'automation' || content.automationId === null) return null
    return session.automationsStore.get(content.automationId) ?? null
  })

  const originalSessionMeta = $derived.by(() => {
    if (!activeWork) return null
    // Candidate sessions, most-recent-linked first, then the legacy origin id.
    const candidates = [
      ...[...(activeWork.sessionIds ?? [])].reverse(),
      ...(activeWork.sessionId ? [activeWork.sessionId] : []),
    ]
    for (const sid of candidates) {
      const openTab = session.tabOrder.find((t) => {
        const s = session.sessionFor(t)
        return s?.agentSessionId === sid || s?.forkedFromSessionId === sid
      })
      if (openTab) {
        const sess = session.sessionFor(openTab)
        if (sess) {
          return {
            sessionId: sess.agentSessionId || '',
            title: session.tabs[openTab]?.title || 'Unnamed session',
            provider: sess.provider || 'claude-code',
            cwd: sess.workingDirectory,
          }
        }
      }
    }
    return null
  })

  // ─── Live-refresh + dirty-conflict for the active work shell ───
  // The shells parse their content once at mount, so an agent update is applied
  // by remounting (bumping renderKey) — but only when the shell has no unsaved
  // edits. If it's dirty, we surface a refresh pill instead of clobbering.
  let shellDirty = $state(false)
  let conflict = $state(false)
  let renderKey = $state(0)
  // Briefly true right after a clean live-refresh, to play the "Updated live"
  // signal (edge-glow + ephemeral pill). Cleared on a timer so the animation
  // runs once per agent update.
  let justUpdated = $state(false)
  let promotingWorkId = $state<string | null>(null)
  let justUpdatedTimer: ReturnType<typeof setTimeout> | null = null
  let trackedWorkId: string | null = null
  let trackedAgentRev = 0

  const agentRev = $derived(content.kind === 'work' ? (session.worksStore.agentRevisions[content.workId] ?? 0) : 0)

  function signalLiveUpdate() {
    if (justUpdatedTimer) clearTimeout(justUpdatedTimer)
    justUpdated = true
    justUpdatedTimer = setTimeout(() => { justUpdated = false }, 1900)
  }

  $effect(() => {
    const workId = content.kind === 'work' ? content.workId : null
    const rev = agentRev
    if (workId !== trackedWorkId) {
      trackedWorkId = workId
      trackedAgentRev = rev
      shellDirty = false
      conflict = false
      justUpdated = false
      return
    }
    if (rev !== trackedAgentRev) {
      trackedAgentRev = rev
      if (shellDirty) conflict = true
      else {
        renderKey++
        signalLiveUpdate()
      }
    }
  })

  $effect(() => () => { if (justUpdatedTimer) clearTimeout(justUpdatedTimer) })

  function refreshFromAgent() {
    conflict = false
    shellDirty = false
    renderKey++
  }

  const sess = $derived(session.sessionFor(session.activeTabId))
  const overlaySourceTabId = $derived(
    content.kind === 'diff' || content.kind === 'files' || content.kind === 'file-editor'
      ? content.sourceTabId
      : null,
  )
  const overlayTab = $derived(overlaySourceTabId ? session.tabs[overlaySourceTabId] : undefined)
  const overlaySession = $derived(overlaySourceTabId ? session.sessionFor(overlaySourceTabId) : undefined)
  const overlayIsWorktree = $derived(!!overlaySession?.gitContext?.worktreePath)

  const promoteTargetRoot = $derived(
    sess?.gitContext?.worktreePath ?? sess?.gitContext?.repoRoot ?? sess?.workingDirectory ?? '',
  )

  function handleOpenInSplit() {
    if (!isMovableContent(content)) return
    panes.moveToOppositeSlot(content, slot)
    if (slot === 'primary') requestInputFocus()
  }

  function handleOpenChatForWork(mode: 'resume' | 'new') {
    if (content.kind !== 'work') return
    void session.openChatForWork(content.workId, mode)
  }

  function handleRename(newTitle: string) {
    if (content.kind !== 'work') return
    void session.worksStore.save(content.workId, { title: newTitle })
  }

  async function handleRevert() {
    if (content.kind !== 'work') return
    const reverted = await window.solus.revertWork(content.workId, sess?.workingDirectory)
    if (!reverted) return
    const existing = session.worksStore.get(content.workId)
    if (existing) {
      existing.content = reverted.content
      existing.preview = reverted.preview
      existing.updatedAt = reverted.updatedAt
    }
    // Reload the shell off the reverted content (shells parse content at mount).
    shellDirty = false
    conflict = false
    renderKey++
  }

  function handleDelete() {
    if (content.kind !== 'work') return
    const work = session.worksStore.get(content.workId)
    if (!work) return
    panes.closeSlot(slot)
    session.requestWorkDelete(work)
  }

  async function handleDuplicate() {
    if (content.kind !== 'work') return
    const duplicated = await session.worksStore.duplicate(content.workId)
    panes.openWork(duplicated.id)
    requestInputFocus()
  }

  async function handlePromoteToProject() {
    if (content.kind !== 'work' || !promoteTargetRoot) return
    promotingWorkId = content.workId
    try {
      await session.worksStore.promoteToProject(content.workId, promoteTargetRoot)
      requestInputFocus()
    } finally {
      if (promotingWorkId === content.workId) promotingWorkId = null
    }
  }
</script>

{#snippet loadingSurface(label: string)}
  <div
    class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
    role="status"
  >
    {label}
  </div>
{/snippet}

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

{#if content.kind === 'plan' && activePlan}
  {#await import('../plan/PlanModal.svelte')}
    {@render loadingSurface('Loading plan…')}
  {:then planModule}
    {@const PlanModal = planModule.default}
    <PlanModal plan={activePlan} inline {slot} onOpenInSplit={handleOpenInSplit} onClose={() => panes.closeSlot(slot)} />
  {/await}
{:else if content.kind === 'work' && activeWork && activeWork.type === 'diagram'}
  <div class="flex h-full flex-col min-h-0 work-live-host" class:work-live-pulse={justUpdated}>
    {#if conflict}
      {@render refreshPill()}
    {/if}
    {#if justUpdated}
      {@render liveBadge()}
    {/if}
    {#key `${activeWork.id}-${renderKey}`}
      <div class="flex-1 min-h-0">
        {#await import('../diagram/DiagramShell.svelte')}
          {@render loadingSurface('Loading diagram…')}
        {:then diagramModule}
          {@const DiagramShell = diagramModule.default}
          <DiagramShell
            content={activeWork.content ?? ''}
            title={activeWork.title}
            workId={activeWork.id}
            onSave={async (c) => { await session.worksStore.save(activeWork.id, { content: c }) }}
            onDirtyChange={(d) => { shellDirty = d }}
            onClose={() => panes.closeSlot(slot)}
            inline
            {slot}
            onOpenInSplit={handleOpenInSplit}
            onOpenChat={handleOpenChatForWork}
            {originalSessionMeta}
            onRename={handleRename}
            onRevert={handleRevert}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            workStorage={activeWork.storage}
            onPromoteToProject={handlePromoteToProject}
            promoting={promotingWorkId === activeWork.id}
          />
        {/await}
      </div>
    {/key}
  </div>
{:else if content.kind === 'work' && activeWork}
  <div class="flex h-full flex-col min-h-0 work-live-host" class:work-live-pulse={justUpdated}>
    {#if conflict}
      {@render refreshPill()}
    {/if}
    {#if justUpdated}
      {@render liveBadge()}
    {/if}
    {#key `${activeWork.id}-${renderKey}`}
      <div class="flex-1 min-h-0">
        {#await import('../document-modal/DocumentModal.svelte')}
          {@render loadingSurface('Loading document…')}
        {:then documentModule}
          {@const DocumentModal = documentModule.default}
          <DocumentModal
            document={{ title: activeWork.title, content: activeWork.content }}
            workId={activeWork.id}
            docType={activeWork.type}
            onSave={async (c) => { await session.worksStore.save(activeWork.id, { content: c }) }}
            onDirtyChange={(d) => { shellDirty = d }}
            onClose={() => panes.closeSlot(slot)}
            inline
            {slot}
            onOpenInSplit={handleOpenInSplit}
            onOpenChat={handleOpenChatForWork}
            {originalSessionMeta}
            onRename={handleRename}
            onRevert={handleRevert}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            workStorage={activeWork.storage}
            onPromoteToProject={handlePromoteToProject}
            promoting={promotingWorkId === activeWork.id}
          />
        {/await}
      </div>
    {/key}
  </div>
{:else if content.kind === 'automation'}
  {#if content.automationId === null || activeAutomation}
    {#key activeAutomation?.id ?? 'new'}
      {#await import('../automations/AutomationBuilder.svelte')}
        {@render loadingSurface('Loading automation…')}
      {:then automationModule}
        {@const AutomationBuilder = automationModule.default}
        <AutomationBuilder
          automation={activeAutomation}
          inline
          {slot}
          onOpenInSplit={handleOpenInSplit}
          onClose={() => panes.closeSlot(slot)}
          onDone={() => panes.closeSlot(slot)}
        />
      {/await}
    {/key}
  {/if}
{:else if content.kind === 'review'}
  {#await import('../review/ReviewGuidePane.svelte')}
    {@render loadingSurface('Loading review…')}
  {:then reviewModule}
    {@const ReviewGuidePane = reviewModule.default}
    <ReviewGuidePane guideKey={content.key} scope={content.scope} {slot} onOpenInSplit={handleOpenInSplit} onClose={() => panes.closeSlot(slot)} />
  {/await}
{:else if content.kind === 'pr-review'}
  {#await import('../pr-review/PrReviewPane.svelte')}
    {@render loadingSurface('Loading pull request review…')}
  {:then prReviewModule}
    {@const PrReviewPane = prReviewModule.default}
    <PrReviewPane
      pr={content.pr}
      chatTabId={content.chatTabId}
      guideKey={content.key}
      {onToggleSecondaryMaximize}
    />
  {/await}
{:else if content.kind === 'pr-review-loading'}
  {#await import('../pr-review/PrReviewSkeleton.svelte')}
    {@render loadingSurface('Preparing pull request review…')}
  {:then prReviewSkeletonModule}
    {@const PrReviewSkeleton = prReviewSkeletonModule.default}
    <PrReviewSkeleton number={content.number} title={content.title} />
  {/await}
{:else if content.kind === 'diff' && overlayTab}
  {#await import('../diff/DiffPanel.svelte')}
    {@render loadingSurface('Loading changes…')}
  {:then diffModule}
    {@const DiffPanel = diffModule.default}
    <DiffPanel
      tabId={overlayTab.id}
      projectPath={overlaySession?.workingDirectory ?? ''}
      worktreePath={overlaySession?.gitContext?.worktreePath}
      worktreeBranch={overlaySession?.gitContext?.branch ?? ''}
      targetBranch={overlaySession?.gitContext?.targetBranch ?? 'HEAD'}
      isWorktree={overlayIsWorktree}
      onClose={() => panes.closeOverlay()}
      maximized={panes.maximized}
      onToggleMaximize={onToggleSecondaryMaximize}
      initialScope={content.scope}
      initialFilePath={content.filePath}
      navigationRequestId={content.navigationRequestId}
    />
  {/await}
{:else if content.kind === 'files' && overlayTab}
  {#await import('../files/FilesPane.svelte')}
    {@render loadingSurface('Loading files…')}
  {:then filesModule}
    {@const FilesPane = filesModule.default}
    <FilesPane
      ctx={session.ctxFor(overlayTab.id)}
      cwd={overlaySession?.gitContext?.worktreePath ?? overlaySession?.workingDirectory ?? ''}
      isDark={session.settings.isDark}
      onClose={() => panes.closeOverlay()}
    />
  {/await}
{:else if content.kind === 'file-editor' && overlayTab}
  {#await import('../files/FileEditorPane.svelte')}
    {@render loadingSurface('Loading file…')}
  {:then fileEditorModule}
    {@const FileEditorPane = fileEditorModule.default}
    <FileEditorPane
      ctx={session.ctxFor(overlayTab.id)}
      cwd={overlaySession?.gitContext?.worktreePath ?? overlaySession?.workingDirectory ?? ''}
      isDark={session.settings.isDark}
      file={content.file}
      onClose={() => panes.closeOverlay()}
    />
  {/await}
{:else if content.kind === 'subagent'}
  {#await import('../conversation/SubagentPane.svelte')}
    {@render loadingSurface('Loading subagent…')}
  {:then subagentModule}
    {@const SubagentPane = subagentModule.default}
    <SubagentPane
      tabId={content.tabId}
      messageId={content.messageId}
      onClose={() => panes.closeOverlay()}
      onToggleMaximize={onToggleSecondaryMaximize}
    />
  {/await}
{:else if content.kind === 'conversation' && content.tabId}
  <!-- A chat pinned beside the primary conversation. Only ever reaches the
       secondary slot: a primary conversation renders through the pool. -->
  {#await import('../conversation/ConversationPane.svelte')}
    {@render loadingSurface('Loading conversation…')}
  {:then conversationModule}
    {@const ConversationPane = conversationModule.default}
    <ConversationPane
      tabId={content.tabId}
      {onAttachFile}
      {onScreenshot}
      {onDesignMode}
      onToggleMaximize={onToggleSecondaryMaximize}
      onClose={() => panes.closeSlot(slot)}
    />
  {/await}
{:else if isPageContent(content)}
  <!-- Pages size themselves with `flex-1` (they used to be children of the
       content column); the secondary slot's wrapper is a block, so it needs the
       explicit height instead. -->
  <div class="flex min-h-0 flex-col {slot === 'secondary' ? 'h-full' : 'flex-1'}">
    {#await PAGE_LOADERS[content.kind]()}
      {@render loadingSurface('Loading page…')}
    {:then pageModule}
      {@const Page = pageModule.default}
      <Page />
    {/await}
  </div>
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
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--solus-text-primary);
  }
  .work-refresh-banner__btn {
    font-size: 0.6875rem;
    font-weight: 600;
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
    content: '';
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;
    box-shadow: inset 0 0 0 0.125rem var(--solus-accent);
    opacity: 0;
    animation: work-live-glow 1100ms var(--ease-premium);
  }
  @keyframes work-live-glow {
    0% { opacity: 0; }
    16% { opacity: 0.85; }
    100% { opacity: 0; }
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
    border-radius: 999px;
    background: var(--solus-accent);
    color: var(--solus-on-accent, #fff);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    pointer-events: none;
    box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.18);
    animation: work-live-badge 1900ms var(--ease-premium) forwards;
  }
  @keyframes work-live-badge {
    0% { opacity: 0; transform: translateY(-0.375rem) scale(0.96); }
    10% { opacity: 1; transform: translateY(0) scale(1); }
    82% { opacity: 1; transform: translateY(0) scale(1); }
    100% { opacity: 0; transform: translateY(-0.25rem) scale(0.98); }
  }
  .work-live-badge__dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: currentColor;
    animation: work-live-dot 1s ease-in-out infinite;
  }
  @keyframes work-live-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  @media (prefers-reduced-motion: reduce) {
    .work-live-pulse::after { animation-duration: 1ms; }
    .work-live-badge { animation: work-live-badge-static 1900ms steps(1, end) forwards; }
    .work-live-badge__dot { animation: none; }
  }
  @keyframes work-live-badge-static {
    0%, 82% { opacity: 1; }
    100% { opacity: 0; }
  }
</style>
