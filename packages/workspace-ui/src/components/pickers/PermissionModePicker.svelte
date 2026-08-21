<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    ShieldCheck as ShieldCheckIcon,
    ShieldEllipsis as ShieldPlanIcon,
    ShieldQuestionMark as ShieldQuestionIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from '../../contexts'
  import type { RunConfig } from '@solus/contracts/types'
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { requestInputFocus } from '../../lib/inputFocus'
  import * as DropdownMenu from '../ui/dropdown-menu'

  type PermissionMode = 'ask' | 'auto' | 'plan'

  interface PermissionOption {
    id: PermissionMode
    label: string
    icon: typeof ShieldCheckIcon
  }

  const session = getWorkspaceContext()
  const agent = getAgentContext()
  const statusBar = getStatusBarContext()

  interface Props {
    compact?: boolean;
    /** The tab whose session this edits. Left unset by a composer that has no
     *  session yet, which supplies `run`/`onRun` instead. */
    tabId?: string;
    /** Detached: the picker reads and writes this run in place and never
     *  touches a session's. A session draft's composer supplies it. */
    run?: RunConfig;
    onRun?: (next: RunConfig) => void;
    /** Choosing from the workspace's own composer returns focus to it. */
    isPrimary?: boolean;
  }
  let { compact = false, tabId, run, onRun, isPrimary = false }: Props = $props();

  let open = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)

  const ctx = $derived(onRun ? statusBar.ctxForRun(run) : statusBar.ctxFor(tabId ?? session.activeTabId))
  const permissionMode = $derived(ctx.permissionMode)
  const isPlan = $derived(permissionMode === 'plan')
  const isAuto = $derived(permissionMode === 'auto')
  const modeLabel = $derived(isPlan ? 'Plan' : isAuto ? 'Auto' : 'Ask')
  const activeAgent = $derived(ctx.activeAgent)
  const capabilities = $derived(
    (agent.metadata[activeAgent] ?? agent.activeMetadata)?.capabilities,
  )
  const supportsPermissions = $derived(capabilities?.permissions !== false)
  const supportsPlan = $derived(capabilities?.planMode !== false)
  const tooltipLabel = $derived.by(() => {
    if (activeAgent === 'codex' && permissionMode === 'plan') return 'Codex read-only planning mode'
    if (activeAgent === 'claude-code' && permissionMode === 'plan') return 'Claude plan mode'
    return 'Permission mode'
  })
  const permissionOptions = $derived(([
    { id: 'ask', label: 'Ask', icon: ShieldQuestionIcon },
    { id: 'auto', label: 'Auto', icon: ShieldCheckIcon },
    { id: 'plan', label: 'Plan', icon: ShieldPlanIcon },
  ] satisfies PermissionOption[]).filter((opt) => opt.id !== 'plan' || supportsPlan))

  function handleToggle() {
    if (!supportsPermissions) return
    open = !open
  }

  function selectPermissionMode(mode: PermissionMode) {
    if (onRun && run) onRun({ ...run, permissionMode: mode })
    else session.setPermissionMode(mode, tabId)
    open = false
    if (isPrimary) requestInputFocus()
  }

  // Same shape as the model chip's shortcut: the picker for the addressed tab
  // opens, and only the copy in the visible layout (both stay mounted).
  function openFromShortcut(targetTabId?: string) {
    if (onRun) return
    if (targetTabId === undefined ? !isPrimary : targetTabId !== tabId) return
    if (!supportsPermissions) return
    if (triggerEl && triggerEl.offsetParent === null) return
    open = true
  }

  $effect(() => {
    const handler = (event: Event) => {
      const detail: { tabId?: string } | undefined =
        event instanceof CustomEvent ? event.detail : undefined
      openFromShortcut(detail?.tabId)
    }
    window.addEventListener('solus:toggle-permission-menu', handler)
    return () => window.removeEventListener('solus:toggle-permission-menu', handler)
  })
</script>

<DropdownMenu.Root bind:open onOpenChange={(next) => { if (!next && isPrimary) requestInputFocus() }}>
  <DropdownMenu.Trigger disabled={!supportsPermissions} bind:ref={triggerEl}>
    {#snippet child({ props })}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button {...tooltipProps}
        {...props}
        type="button"
        class="flex h-[1.875rem] items-center gap-1.5 rounded-lg border-[0.5px] border-(--solus-container-border) px-2.5 font-secondary text-workspace-chrome text-(--solus-text-secondary) transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) {open ? 'bg-(--solus-surface-hover)' : ''}"
        style="cursor:{supportsPermissions ? 'pointer' : 'not-allowed'};opacity:{supportsPermissions ? 1 : 0.5}"
      >
        <span class="inline-flex size-[1em] shrink-0 items-center justify-center text-(--solus-accent)" aria-hidden="true">
          {#if isPlan}<ShieldPlanIcon class="block size-full" />{:else if isAuto}<ShieldCheckIcon class="block size-full" />{:else}<ShieldQuestionIcon class="block size-full" />{/if}
        </span>
        {#if !compact}<span class="font-medium">{modeLabel}</span>{/if}
        <CaretDownIcon size={9} class="text-(--solus-text-tertiary) transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={open ? null : tooltipLabel} />
      </TooltipUI.Root>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="start"
    sideOffset={6}
    class="w-[176px] text-workspace-chrome [&_.menu-row]:text-workspace-chrome"
  >
    <DropdownMenu.RadioGroup value={permissionMode}>
      {#each permissionOptions as opt (opt.id)}
        {@const Icon = opt.icon}
        {@const isChecked = permissionMode === opt.id}
        <DropdownMenu.RadioItem value={opt.id} class="gap-2.5 pl-1.5" onSelect={() => selectPermissionMode(opt.id)}>
          <span class="flex size-6 shrink-0 items-center justify-center rounded-lg transition-colors {isChecked ? 'bg-[color-mix(in_srgb,var(--solus-accent)_16%,transparent)] text-(--solus-accent)' : 'bg-(--solus-surface-hover)'}">
            <Icon size={15} class="h-[15px] w-[17px]" />
          </span>
          <span>{opt.label}</span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
