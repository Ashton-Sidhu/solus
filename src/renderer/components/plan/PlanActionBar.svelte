<script lang="ts">
  import { tick } from 'svelte'
  import { XIcon, ArrowCounterClockwiseIcon, RobotIcon, CheckIcon, GitForkIcon } from 'phosphor-svelte'
  import { getWorkspaceContext, getStatusBarContext, runtime } from '../../contexts'
  import { useKeybinding, useScope } from '../../lib/keybindings/use-keybinding.svelte'
  import { Button } from '../ui/button'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import { PromptComposer } from '../ui/prompt-composer'
  import PlanApproveButton from './PlanApproveButton.svelte'
  import Kbd from '../ui/Kbd.svelte'

  interface Props {
    planId: string
    inlineCommentCount?: number
    compact?: boolean
    forceShowWorktreeToggle?: boolean
    onDone?: () => void
  }

  let { planId, inlineCommentCount = 0, compact = false, forceShowWorktreeToggle = false, onDone }: Props = $props()

  const session = getWorkspaceContext()
  const statusBar = getStatusBarContext()

  let actionComment = $state('')
  let composerRef: ReturnType<typeof PromptComposer> | null = $state(null)
  let menuOpen = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)
  // Owned here so ⌥D can drive the composer's collapse and the worktree binding
  // can stand down while its switch is off screen.
  let collapsed = $state(false)

  const sess = $derived(session.sessionFor(session.activeTabId))
  const hasGit = $derived(!!sess?.gitContext)
  const alreadyInWorktree = $derived(!!sess?.gitContext?.worktreePath)
  let useWorktree = $state(false)
  const showWorktreeToggle = $derived((hasGit || forceShowWorktreeToggle) && !alreadyInWorktree)

  const hasRevise = $derived(actionComment.trim().length > 0 || inlineCommentCount > 0)
  const isMobile = $derived(runtime.isMobileViewport)

  useScope('plan-action-bar');

  useKeybinding('plan-review.approve-ask', () => handleApprove('ask'));
  useKeybinding('plan-review.approve-auto', () => handleApprove('auto'));
  useKeybinding('plan-review.reject', () => { session.rejectPlan(planId); onDone?.(); });
  useKeybinding('plan-review.reject-revise', () => handleRevise(), { enabled: () => hasRevise });
  useKeybinding('plan-review.focus-comment', () => void focusComposer());
  useKeybinding('plan-review.toggle-worktree', () => { useWorktree = !useWorktree }, { enabled: () => showWorktreeToggle && !collapsed });
  useKeybinding('plan-review.toggle-collapsed', () => { collapsed = !collapsed });

  /** Expands first — a hidden editor can't take focus. */
  async function focusComposer() {
    collapsed = false
    await tick()
    composerRef?.focus()
  }

  function handleApprove(mode: 'ask' | 'auto') {
    menuOpen = false
    const picked = composerRef?.payload()
    // Only pass provider/model when they differ from the session's effective
    // config — the pair triggers a provider switch + agent-session reset.
    const current = statusBar.ctxFor(session.activeTabId)
    const modelChanged = picked
      && !!picked.modelId
      && (picked.provider !== current.activeAgent || picked.modelId !== (current.model || null))
    session.approvePlanWithModel(planId, mode, {
      ...(picked && modelChanged ? { provider: picked.provider, modelId: picked.modelId! } : {}),
      reasoningEffort: picked?.reasoningEffort,
      generalComment: actionComment.trim() || undefined,
      useWorktree: useWorktree || undefined,
      planRefs: picked?.planRefs,
      workRefs: picked?.workRefs,
    })
    onDone?.()
  }

  function handleReject() {
    menuOpen = false
    session.rejectPlan(planId)
    onDone?.()
  }

  function handleRevise() {
    if (!hasRevise) {
      void focusComposer()
      return
    }
    menuOpen = false
    session.rejectPlan(planId, actionComment.trim() || undefined)
    onDone?.()
  }
</script>


<div class="plan-action-bar">
  <PromptComposer
    bind:this={composerRef}
    bind:value={actionComment}
    bind:collapsed
    tabId={session.activeTabId}
    workingDirectory={sess?.workingDirectory}
    allowAgentSwitch
    menuPlacement="up"
    size={compact ? 'sm' : 'lg'}
    showWorktree={showWorktreeToggle && !compact}
    bind:useWorktree
    placeholder={isMobile ? "Add a note…" : "Add a note… (⌥L)"}
  >
    {#snippet trailing()}
      {#if compact}
        <button
          bind:this={triggerEl}
          type="button"
          onclick={() => { menuOpen = !menuOpen }}
          class="plan-action-more"
          class:plan-action-more--open={menuOpen}
          title="More actions"
          aria-expanded={menuOpen}
        >
          <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>
        </button>
      {:else if hasRevise}
        <Button data-testid="plan-action-revise" variant="outline" size="sm" class="plan-btn-desktop hover:text-(--solus-error)" onclick={handleRevise}>
          <ArrowCounterClockwiseIcon size={14} />
          Revise
          {#if !isMobile}<Kbd variant="inline" class="ml-1">⌥V</Kbd>{/if}
        </Button>
      {:else}
        <Button data-testid="plan-action-reject" variant="outline" size="sm" class="plan-btn-desktop hover:text-(--solus-error)" onclick={handleReject}>
          <XIcon size={14} />
          Reject
          {#if !isMobile}<Kbd variant="inline" class="ml-1">⌥R</Kbd>{/if}
        </Button>
      {/if}

      <PlanApproveButton
        bind:useWorktree
        showWorktreeToggle={false}
        onApprove={handleApprove}
        {compact}
      />
    {/snippet}
  </PromptComposer>
</div>

{#if compact && triggerEl}
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Content customAnchor={triggerEl} side="bottom" align="start" sideOffset={6} class="w-[180px]">
      <DropdownMenu.Item data-testid="plan-action-yes" onSelect={() => handleApprove('ask')}>
        <RobotIcon size={14} />
        <span class="flex-1 text-left">Yes</span>
        {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥Y</Kbd></span>{/if}
      </DropdownMenu.Item>
      <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
      <DropdownMenu.Item data-testid="plan-action-reject" variant="destructive" onSelect={handleReject}>
        <XIcon size={14} />
        <span class="flex-1 text-left">Reject</span>
        {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥R</Kbd></span>{/if}
      </DropdownMenu.Item>
      <DropdownMenu.Item data-testid="plan-action-revise" variant="destructive" onSelect={handleRevise}>
        <ArrowCounterClockwiseIcon size={14} />
        <span class="flex-1 text-left">Revise</span>
        {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥V</Kbd></span>{/if}
      </DropdownMenu.Item>
      {#if showWorktreeToggle}
        <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
        <DropdownMenu.Item data-testid="plan-action-worktree" closeOnSelect={false} onSelect={() => { useWorktree = !useWorktree }}>
          <GitForkIcon size={14} class={useWorktree ? 'text-(--solus-accent)' : ''} />
          <span class="flex-1 text-left">Worktree</span>
          {#if useWorktree}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
          {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥W</Kbd></span>{/if}
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<style>
  /* Matches the lg composer's 2.25rem control row. */
  :global(.plan-btn-desktop) {
    height: 2.25rem !important;
  }

  .plan-action-more {
    width: 1.875rem;
    height: 1.875rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    border: 0.0625rem solid var(--solus-tool-border);
    background: transparent;
    color: var(--solus-text-secondary);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      border-color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  .plan-action-more:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
    border-color: color-mix(in srgb, var(--solus-tool-border) 50%, var(--solus-text-tertiary));
  }
  .plan-action-more:active {
    transform: scale(0.95);
  }
  .plan-action-more--open {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
    border-color: var(--solus-accent-border);
  }
  .plan-action-more:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }
</style>
