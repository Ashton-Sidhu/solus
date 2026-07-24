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
  }

  let { useWorktree = $bindable(false), showWorktreeToggle = false, onApprove }: Props = $props()

  let open = $state(false)
  const isMobile = $derived(runtime.isMobileViewport)
</script>

<!-- Split button: one accent slab, seam drawn by the caret's ::before rule.
     Height tracks the composer's 2.25rem control row. -->
<div class="inline-flex h-9 overflow-hidden rounded-md max-md:flex-1">
  <button
    type="button"
    onclick={() => onApprove('auto')}
    data-testid="plan-action-yes-auto"
    class="flex h-9 cursor-pointer items-center gap-1 rounded-l-md border border-r-0 border-transparent bg-(--solus-accent) px-2.5 text-[0.8rem] font-medium text-white shadow-[0_0.0625rem_0.125rem_rgba(217,119,87,0.25),inset_0_0_0_0.0625rem_rgba(255,255,255,0.10)] transition-[background-color,box-shadow,transform] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-send-hover) hover:shadow-[0_0.125rem_0.5rem_rgba(217,119,87,0.32),inset_0_0_0_0.0625rem_rgba(255,255,255,0.12)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) motion-reduce:transition-none motion-reduce:active:scale-100 max-md:flex-1 max-md:justify-center max-md:pr-1"
  >
    <CheckIcon size={14} />
    Approve
    {#if !isMobile}<span class="ml-0.5 font-mono text-[0.5625rem] tracking-[0.02em] tabular-nums opacity-45">⌥A</span>{/if}
  </button>
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex h-9 w-6 cursor-pointer items-center justify-center rounded-r-md border border-l-0 border-transparent bg-(--solus-accent) text-white shadow-[0_0.0625rem_0.125rem_rgba(217,119,87,0.25),inset_0_0_0_0.0625rem_rgba(255,255,255,0.10)] transition-[background-color,box-shadow] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-send-hover) hover:shadow-[0_0.125rem_0.5rem_rgba(217,119,87,0.32),inset_0_0_0_0.0625rem_rgba(255,255,255,0.12)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) motion-reduce:transition-none before:absolute before:top-1 before:bottom-1 before:left-0 before:w-px before:bg-white/30 before:opacity-25 before:content-[''] max-md:w-5.5"
          aria-label="More approve options"
        >
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
