<script lang="ts">
  import { XIcon, ArrowCounterClockwiseIcon, RobotIcon, CheckIcon, GitForkIcon } from 'phosphor-svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import { useKeybinding, useScope } from '../../lib/keybindings/use-keybinding.svelte'
  import { runtime } from '../../contexts/runtime.svelte'
  import { Button } from '../ui/button'
  import { Toggle } from '../ui/toggle'
  import { MarkdownTextarea } from '../ui/markdown-field'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import PlanSplitButton from './PlanSplitButton.svelte'
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

  let actionComment = $state('')
  let noteEl: HTMLTextAreaElement | null = $state(null)
  let menuOpen = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)

  const sess = $derived(session.sessionFor(session.activeTabId))
  const hasGit = $derived(!!sess?.gitContext)
  const alreadyInWorktree = $derived(!!sess?.gitContext?.worktreePath)
  let useWorktree = $state(false)
  const showWorktreeToggle = $derived((hasGit || forceShowWorktreeToggle) && !alreadyInWorktree)

  const hasRevise = $derived(actionComment.trim().length > 0 || inlineCommentCount > 0)
  const gap = $derived(compact ? 'gap-1.5' : 'gap-2')
  const isMobile = $derived(runtime.isMobileViewport)

  useScope('plan-action-bar');

  useKeybinding('plan-review.approve-ask', () => { session.approvePlanWithModel(planId, 'ask', undefined, undefined, actionComment.trim() || undefined, useWorktree || undefined); onDone?.(); });
  useKeybinding('plan-review.approve-auto', () => { session.approvePlanWithModel(planId, 'auto', undefined, undefined, actionComment.trim() || undefined, useWorktree || undefined); onDone?.(); });
  useKeybinding('plan-review.reject', () => { session.rejectPlan(planId); onDone?.(); });
  useKeybinding('plan-review.reject-revise', () => { session.rejectPlan(planId, actionComment.trim() || undefined); onDone?.(); }, { enabled: () => hasRevise });
  useKeybinding('plan-review.focus-comment', () => noteEl?.focus());
  useKeybinding('plan-review.toggle-worktree', () => { if (showWorktreeToggle) useWorktree = !useWorktree }, { enabled: () => showWorktreeToggle });

  function handleReject() {
    menuOpen = false
    session.rejectPlan(planId)
    onDone?.()
  }

  function handleRevise() {
    if (!hasRevise) {
      noteEl?.focus()
      return
    }
    menuOpen = false
    session.rejectPlan(planId, actionComment.trim() || undefined)
    onDone?.()
  }

  function handleAskApprove() {
    menuOpen = false
    session.approvePlanWithModel(planId, 'ask', undefined, undefined, actionComment.trim() || undefined, useWorktree || undefined)
    onDone?.()
  }
</script>


<div class="plan-action-bar flex items-center {gap}">
  <div class="plan-action-input flex-1 min-w-0" class:plan-action-input--compact={compact}>
    <MarkdownTextarea
      bind:ref={noteEl}
      bind:value={actionComment}
      bare
      placeholder={isMobile ? "Add a note…" : "Add a note… (⌥L)"}
      rows={1}
      data-testid="plan-action-comment"
    />
  </div>

  {#if showWorktreeToggle && !compact}
    <Toggle
      variant="outline"
      size="sm"
      pressed={useWorktree}
      onPressedChange={(v) => { useWorktree = v }}
      data-testid="plan-action-worktree"
      class="w-7 min-w-0 shrink-0 px-0 text-(--solus-text-tertiary) data-[state=on]:border-(--solus-accent-border) data-[state=on]:bg-(--solus-accent-light) data-[state=on]:text-(--solus-accent)"
      title={useWorktree ? 'Worktree enabled — will implement in isolated branch (⌥W)' : 'Enable worktree — implement in isolated branch (⌥W)'}
    >
      <GitForkIcon size={14} />
    </Toggle>
  {/if}

  <div class="flex items-center {gap} shrink-0">
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
    {:else}
      <Button data-testid="plan-action-reject" variant="outline" size="sm" class="plan-btn-desktop hover:text-(--solus-error)" onclick={handleReject}>
        <XIcon size={14} />
        Reject
        {#if !isMobile}<Kbd variant="inline" class="ml-1">⌥R</Kbd>{/if}
      </Button>
      <Button data-testid="plan-action-revise" variant="outline" size="sm" class="plan-btn-desktop hover:text-(--solus-error)" onclick={handleRevise}>
        <ArrowCounterClockwiseIcon size={14} />
        Revise
        {#if !isMobile}<Kbd variant="inline" class="ml-1">⌥V</Kbd>{/if}
      </Button>
      <Button data-testid="plan-action-yes" variant="secondary" size="sm" class="plan-btn-desktop" onclick={handleAskApprove}>
        <CheckIcon size={14} />
        Yes
        {#if !isMobile}<Kbd variant="inline" class="ml-1">⌥Y</Kbd>{/if}
      </Button>
    {/if}

    <PlanSplitButton
      label="Yes Auto"
      mode="auto"
      {planId}
      {compact}
      variant="primary"
      kbdHint="⌥A"
      actionComment={actionComment.trim()}
      useWorktree={useWorktree || undefined}
      {onDone}
    />
  </div>
</div>

{#if compact && triggerEl}
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Content customAnchor={triggerEl} side="bottom" align="start" sideOffset={6} class="w-[180px]">
      <DropdownMenu.Item data-testid="plan-action-yes" onSelect={handleAskApprove}>
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
  .plan-action-input {
    border-radius: 0.4375rem;
    padding: 0.3125rem 0.625rem;
    background: var(--solus-input-bg-soft);
    border: 0.0625rem solid var(--solus-tool-border);
    line-height: 1.4;
    display: flex;
    align-items: center;
    transition: border-color var(--duration-base) var(--ease-premium),
                box-shadow var(--duration-base) var(--ease-premium),
                background var(--duration-base) var(--ease-premium);
  }
  .plan-action-input:hover {
    border-color: color-mix(in srgb, var(--solus-tool-border) 60%, var(--solus-text-tertiary));
  }
  .plan-action-input:focus-within {
    border-color: var(--solus-input-focus-border);
    box-shadow: 0 0 0 0.1875rem var(--solus-input-focus-ring);
    background: var(--solus-container-bg);
  }
  .plan-action-input--compact {
    padding: 0.25rem 0.5625rem;
    border-radius: 0.375rem;
  }
  :global(.plan-btn-desktop) {
    height: 1.875rem !important;
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
