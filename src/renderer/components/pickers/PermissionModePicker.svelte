<script lang="ts">
  import { CaretDownIcon, ShieldCheckIcon, PencilIcon, type IconWeight } from 'phosphor-svelte'
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from '../../contexts'
  import type { RunConfig } from '../../../shared/types'
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { requestInputFocus } from '../../lib/inputFocus'
  import * as DropdownMenu from '../ui/dropdown-menu'

  type PermissionMode = 'ask' | 'auto' | 'plan'

  interface PermissionOption {
    id: PermissionMode
    label: string
    icon: typeof ShieldCheckIcon
    weight: IconWeight
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
    { id: 'ask', label: 'Ask', icon: ShieldCheckIcon, weight: 'regular' },
    { id: 'auto', label: 'Auto', icon: ShieldCheckIcon, weight: 'fill' },
    { id: 'plan', label: 'Plan', icon: PencilIcon, weight: isPlan ? 'fill' : 'regular' },
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
        class="flex h-[1.875rem] items-center gap-1.5 rounded-lg border-[0.5px] border-(--solus-container-border) px-2.5 font-secondary text-sm text-(--solus-text-secondary) transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) {open ? 'bg-(--solus-surface-hover)' : ''}"
        style="cursor:{supportsPermissions ? 'pointer' : 'not-allowed'};opacity:{supportsPermissions ? 1 : 0.5}"
      >
        {#if isPlan}<PencilIcon size={12} weight="fill" class="text-(--solus-accent)" />{:else}<ShieldCheckIcon size={12} weight={isAuto ? 'fill' : 'regular'} class="text-(--solus-accent)" />{/if}
        {#if !compact}<span class="font-medium">{modeLabel}</span>{/if}
        <CaretDownIcon size={9} class="text-(--solus-text-tertiary) transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={open ? null : tooltipLabel} />
      </TooltipUI.Root>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="w-[176px]">
    <DropdownMenu.RadioGroup value={permissionMode}>
      {#each permissionOptions as opt (opt.id)}
        {@const Icon = opt.icon}
        {@const isChecked = permissionMode === opt.id}
        <DropdownMenu.RadioItem value={opt.id} class="gap-2.5 pl-1.5" onSelect={() => selectPermissionMode(opt.id)}>
          <span class="flex size-6 shrink-0 items-center justify-center rounded-lg transition-colors {isChecked ? 'bg-[color-mix(in_srgb,var(--solus-accent)_16%,transparent)] text-(--solus-accent)' : 'bg-(--solus-surface-hover)'}">
            <Icon size={13} weight={opt.weight} class="size-3.5" />
          </span>
          <span>{opt.label}</span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
