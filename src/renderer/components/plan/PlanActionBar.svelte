<script lang="ts">
  import { tick } from 'svelte'
  import { XIcon, ArrowCounterClockwiseIcon, RobotIcon, CheckIcon, GitForkIcon, ChatsIcon } from 'phosphor-svelte'
  import { getWorkspaceContext, getStatusBarContext, runtime } from '../../contexts'
  import { useKeybinding, useScope } from '../../lib/keybindings/use-keybinding.svelte'
  import { Button } from '../ui/button'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import { PromptComposer } from '../ui/prompt-composer'
  import * as TooltipUI from '../ui/tooltip'
  import PlanApproveButton from './PlanApproveButton.svelte'
  import Kbd from '../ui/Kbd.svelte'

  interface Props {
    planId: string
    inlineCommentCount?: number
    compact?: boolean
    forceShowWorktreeToggle?: boolean
    collapsed?: boolean
    onDone?: () => void
  }

  let {
    planId,
    inlineCommentCount = 0,
    compact = false,
    forceShowWorktreeToggle = false,
    collapsed = $bindable(false),
    onDone,
  }: Props = $props()

  const session = getWorkspaceContext()
  const statusBar = getStatusBarContext()

  let actionComment = $state('')
  let composerRef: ReturnType<typeof PromptComposer> | null = $state(null)
  let menuOpen = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)
  const sess = $derived(session.sessionFor(session.activeTabId))
  const hasGit = $derived(!!sess?.gitContext)
  const alreadyInWorktree = $derived(!!sess?.gitContext?.worktreePath)
  let useWorktree = $state(false)
  let startNewSession = $state(true)
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
      startNewSession,
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


<div class="plan-action-bar" class:pointer-events-none={collapsed}>
  <PromptComposer
    bind:this={composerRef}
    bind:value={actionComment}
    bind:collapsed
    tabId={session.activeTabId}
    workingDirectory={sess?.workingDirectory}
    menuPlacement="up"
    placeholder={isMobile ? "Add a note…" : "Add a note… (⌥L)"}
  >
    {#snippet afterPicker()}
      {#if !compact}
        <div class="flex items-center gap-3">
        {#if showWorktreeToggle}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  onclick={() => {
                    useWorktree = !useWorktree
                    composerRef?.focus()
                  }}
                  class="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full transition-[background-color,color,scale] duration-(--duration-quick) ease-(--ease-premium) after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) {useWorktree
                    ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
                    : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                  data-testid="plan-action-worktree"
                  aria-label="Run approved work in an isolated worktree"
                  aria-pressed={useWorktree}
                >
                  <GitForkIcon
                    size={15}
                    weight={useWorktree ? "bold" : "regular"}
                  />
                </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content
              value={useWorktree
                ? "Worktree on — click to run in the current checkout"
                : "Worktree off — click to run in an isolated worktree"}
            />
          </TooltipUI.Root>
        {/if}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                onclick={() => {
                  startNewSession = !startNewSession
                  composerRef?.focus()
                }}
                class="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full transition-[background-color,color,scale] duration-(--duration-quick) ease-(--ease-premium) after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) {startNewSession
                  ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                data-testid="plan-action-new-session"
                aria-label="Start approved work in a new session"
                aria-pressed={startNewSession}
              >
                <ChatsIcon
                  size={15}
                  weight={startNewSession ? "bold" : "regular"}
                />
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content
            value={startNewSession
              ? "New session on — click to continue in this session"
              : "New session off — click to start approved work in a new session"}
          />
        </TooltipUI.Root>
        </div>
      {/if}
    {/snippet}

    {#snippet trailing()}
      {#if compact}
        <button
          bind:this={triggerEl}
          type="button"
          onclick={() => { menuOpen = !menuOpen }}
          class="flex size-9 cursor-pointer items-center justify-center rounded-md border transition-[background-color,color,border-color,transform] duration-(--duration-quick) ease-(--ease-premium) active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) {menuOpen
            ? 'border-(--solus-accent-border) bg-(--solus-surface-hover) text-(--solus-text-primary)'
            : 'border-(--solus-tool-border) bg-transparent font-secondary text-(--solus-text-secondary) hover:border-[color-mix(in_srgb,var(--solus-tool-border)_50%,var(--solus-text-tertiary))] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
          title="More actions"
          aria-expanded={menuOpen}
        >
          <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>
        </button>
      {:else if hasRevise}
        <Button data-testid="plan-action-revise" variant="outline" size="sm" class="hover:text-(--solus-error) max-md:h-9" onclick={handleRevise}>
          <ArrowCounterClockwiseIcon size={13} />
          Revise
          {#if !isMobile}<Kbd variant="inline" class="ml-1">⌥V</Kbd>{/if}
        </Button>
      {:else}
        <Button data-testid="plan-action-reject" variant="outline" size="sm" class="hover:text-(--solus-error) max-md:h-9" onclick={handleReject}>
          <XIcon size={13} />
          Reject
          {#if !isMobile}<Kbd variant="inline" class="ml-1">⌥R</Kbd>{/if}
        </Button>
      {/if}

      <PlanApproveButton
        bind:useWorktree
        bind:startNewSession
        showNewSessionOption={compact}
        showWorktreeToggle={false}
        onApprove={handleApprove}
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
