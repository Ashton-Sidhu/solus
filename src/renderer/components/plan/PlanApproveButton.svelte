<script lang="ts">
  import { CheckIcon, CaretDownIcon, GitForkIcon, RobotIcon } from 'phosphor-svelte'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import Kbd from '../ui/Kbd.svelte'
  import { runtime } from '../../contexts'

  // Primary approve split button: the main segment approves in auto mode
  // (today's primary action); the caret offers ask-each-step and the worktree
  // toggle. Model/effort knowledge lives in the composer's SessionChip — the
  // host passes the picker selection into approvePlanWithModel itself.
  interface Props {
    useWorktree?: boolean
    showWorktreeToggle?: boolean
    onApprove: (mode: 'ask' | 'auto') => void
    compact?: boolean
  }

  let { useWorktree = $bindable(false), showWorktreeToggle = false, onApprove, compact = false }: Props = $props()

  let open = $state(false)
  const isMobile = $derived(runtime.isMobileViewport)
  const sizeClass = $derived(compact ? 'plan-split--compact' : '')
</script>

<div class="plan-split-wrap {sizeClass}">
  <button
    type="button"
    onclick={() => onApprove('auto')}
    data-testid="plan-action-yes-auto"
    class="plan-split-main {sizeClass} flex items-center gap-1"
  >
    <CheckIcon size={compact ? 12 : 14} />
    Approve
    {#if !isMobile}<span class="plan-split-kbd">⌥A</span>{/if}
  </button>
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button {...props} type="button" class="plan-split-caret {sizeClass}" aria-label="More approve options">
          <CaretDownIcon size={10} />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[220px]">
      <DropdownMenu.Item data-testid="plan-action-yes" onSelect={() => { open = false; onApprove('ask') }}>
        <RobotIcon size={14} />
        <span class="flex-1 text-left">Approve, ask each step</span>
        {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥Y</Kbd></span>{/if}
      </DropdownMenu.Item>
      {#if showWorktreeToggle}
        <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
        <DropdownMenu.Item data-testid="plan-action-worktree" closeOnSelect={false} onSelect={() => { useWorktree = !useWorktree }}>
          <GitForkIcon size={14} class={useWorktree ? 'text-(--solus-accent)' : ''} />
          <span class="flex-1 text-left">Use worktree</span>
          {#if useWorktree}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
          {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥W</Kbd></span>{/if}
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>

<style>
  /* Full size lines up with the lg composer's 2.25rem control row; compact is
   * the dense mobile row. */
  .plan-split-wrap {
    display: inline-flex;
    height: 2.25rem;
    border-radius: 0.375rem;
    overflow: hidden;
    box-sizing: border-box;
  }
  .plan-split-wrap.plan-split--compact,
  .plan-split-main.plan-split--compact,
  .plan-split-caret.plan-split--compact {
    height: 1.875rem;
  }

  .plan-split-kbd {
    font-size: 0.5625rem;
    opacity: 0.45;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
    margin-left: 0.125rem;
    font-variant-numeric: tabular-nums;
  }

  .plan-split-main {
    height: 2.25rem;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0 0.625rem;
    border: 0.0625rem solid transparent;
    border-right: none;
    border-radius: 0.375rem 0 0 0.375rem;
    cursor: pointer;
    box-sizing: border-box;
    background: var(--solus-accent);
    color: #fff;
    box-shadow:
      0 0.0625rem 0.125rem rgba(217, 119, 87, 0.25),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.10);
    transition: background var(--duration-quick) var(--ease-premium),
                color var(--duration-quick) var(--ease-premium),
                transform 80ms var(--ease-premium);
  }
  .plan-split-main:hover {
    background: var(--solus-send-hover);
    box-shadow:
      0 0.125rem 0.5rem rgba(217, 119, 87, 0.32),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.12);
  }
  .plan-split-main:active {
    transform: scale(0.97);
  }

  .plan-split-caret {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 2.25rem;
    width: 1.5rem;
    border: 0.0625rem solid transparent;
    border-left: none;
    border-radius: 0 0.375rem 0.375rem 0;
    cursor: pointer;
    box-sizing: border-box;
    background: var(--solus-accent);
    color: #fff;
    box-shadow:
      0 0.0625rem 0.125rem rgba(217, 119, 87, 0.25),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.10);
    transition: background var(--duration-quick) var(--ease-premium),
                filter var(--duration-quick) var(--ease-premium);
    position: relative;
  }
  .plan-split-caret:hover {
    background: var(--solus-send-hover);
    box-shadow:
      0 0.125rem 0.5rem rgba(217, 119, 87, 0.32),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.12);
  }
  .plan-split-caret::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.25rem;
    bottom: 0.25rem;
    width: 0.0625rem;
    opacity: 0.25;
    background: rgba(255, 255, 255, 0.3);
  }

  .plan-split-main:focus-visible,
  .plan-split-caret:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  @media (max-width: 767px) {
    .plan-split-wrap {
      flex: 1;
    }

    .plan-split-main {
      flex: 1;
      justify-content: center;
      font-size: 0.8rem;
      padding: 0 0.25rem 0 0.625rem;
    }

    .plan-split-caret {
      width: 1.375rem;
    }

    .plan-split-kbd {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .plan-split-main,
    .plan-split-caret {
      transition: none !important;
    }
    .plan-split-main:active {
      transform: none !important;
    }
  }
</style>
