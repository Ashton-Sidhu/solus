<script lang="ts">
  import { CaretDownIcon, ShieldCheckIcon, PencilIcon, type IconWeight } from 'phosphor-svelte'
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from '../../contexts'
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { requestInputFocus } from '../../lib/inputFocus'
  import * as DropdownMenu from '../ui/dropdown-menu'

  const session = getWorkspaceContext()
  const agent = getAgentContext()
  const statusBar = getStatusBarContext()

  interface Props {
    compact?: boolean;
    tabId?: string;
  }
  let { compact = false, tabId }: Props = $props();

  let open = $state(false)

  const ctx = $derived(statusBar.ctxFor(tabId ?? session.activeTabId))
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
  const permissionOptions = $derived([
    { id: 'ask', label: 'Ask', icon: ShieldCheckIcon, weight: 'regular' as IconWeight },
    { id: 'auto', label: 'Auto', icon: ShieldCheckIcon, weight: 'fill' as IconWeight },
    { id: 'plan', label: 'Plan', icon: PencilIcon, weight: (isPlan ? 'fill' : 'regular') as IconWeight },
  ].filter((opt) => opt.id !== 'plan' || supportsPlan))

  function handleToggle() {
    if (!supportsPermissions) return
    open = !open
  }

  function selectPermissionMode(mode: 'ask' | 'auto' | 'plan') {
    session.setPermissionMode(mode, tabId)
    open = false
    if (tabId === undefined) requestInputFocus()
  }
</script>

<DropdownMenu.Root bind:open onOpenChange={(next) => { if (!next && tabId === undefined) requestInputFocus() }}>
  <DropdownMenu.Trigger disabled={!supportsPermissions}>
    {#snippet child({ props })}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button {...tooltipProps}
        {...props}
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg border border-(--solus-container-border) bg-(--solus-container-bg) px-2.5 font-secondary text-[0.8125rem] text-(--solus-text-secondary) shadow-xs transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light)"
        style="cursor:{supportsPermissions ? 'pointer' : 'not-allowed'};opacity:{supportsPermissions ? 1 : 0.5}"
      >
        {#if isPlan}<PencilIcon size={13} weight="fill" class="text-(--solus-accent)" />{:else}<ShieldCheckIcon size={13} weight={isAuto ? 'fill' : 'regular'} class="text-(--solus-accent)" />{/if}
        {#if !compact}{modeLabel}{/if}
        <CaretDownIcon size={9} class="text-(--solus-text-tertiary)" />
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
        <DropdownMenu.RadioItem value={opt.id} class="gap-2.5 pl-1.5" onSelect={() => selectPermissionMode(opt.id as 'ask' | 'auto' | 'plan')}>
          <span class="flex size-6 shrink-0 items-center justify-center rounded-[7px] transition-colors {isChecked ? 'bg-[color-mix(in_srgb,var(--solus-accent)_16%,transparent)] text-(--solus-accent)' : 'bg-(--solus-surface-hover)'}">
            <Icon size={13} weight={opt.weight} class="size-3.5" />
          </span>
          <span>{opt.label}</span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
