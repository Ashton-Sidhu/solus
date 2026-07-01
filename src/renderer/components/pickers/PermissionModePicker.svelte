<script lang="ts">
  import { CaretDownIcon, CheckIcon, ShieldCheckIcon, PencilIcon, type IconWeight } from 'phosphor-svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import { getAgentContext } from '../../contexts/agent.context.svelte'
  import { getStatusBarContext } from '../../contexts/status-bar.context.svelte'
  import { tooltip } from '../../lib/tooltip'
  import { requestInputFocus } from '../../lib/inputFocus'
  import Dropdown from '../ui/Dropdown.svelte'
  import DropdownItem from '../ui/DropdownItem.svelte'

  const session = getWorkspaceContext()
  const agent = getAgentContext()
  const statusBar = getStatusBarContext()

  interface Props {
    compact?: boolean;
  }
  let { compact = false }: Props = $props();

  let open = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)

  const ctx = $derived(statusBar.ctx)
  const permissionMode = $derived(ctx.permissionMode)
  const isPlan = $derived(permissionMode === 'plan')
  const isAuto = $derived(permissionMode === 'auto')
  const modeLabel = $derived(isPlan ? 'Plan' : isAuto ? 'Auto' : 'Ask')
  const activeAgent = $derived(ctx.activeAgent)
  const capabilities = $derived(agent.activeMetadata?.capabilities)
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
    session.setPermissionMode(mode)
    open = false
    requestInputFocus()
  }
</script>

<button
  bind:this={triggerEl}
  type="button"
  onclick={handleToggle}
  aria-haspopup="menu"
  aria-expanded={open}
  class="flex items-center gap-0.5 text-[0.75rem] rounded-full px-1.5 py-0.5 transition-[background-color,color,scale] text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)] hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)"
  style="cursor:{supportsPermissions ? 'pointer' : 'not-allowed'};opacity:{supportsPermissions ? 1 : 0.5}"
  use:tooltip={open ? null : tooltipLabel}
>
  {#if isPlan}
    <PencilIcon size={11} weight="fill" />
  {:else}
    <ShieldCheckIcon size={11} weight={isAuto ? 'fill' : 'regular'} />
  {/if}
  {#if !compact}{modeLabel}{/if}
  <CaretDownIcon size={10} style="opacity:0.6" />
</button>

<Dropdown bind:open {triggerEl} align="bottom" width={176}>
  <div class="py-1">
    {#each permissionOptions as opt (opt.id)}
      {@const Icon = opt.icon}
      <DropdownItem
        selected={permissionMode === opt.id}
        onclick={() => selectPermissionMode(opt.id as 'ask' | 'auto' | 'plan')}
      >
        <Icon size={12} weight={opt.weight} class="shrink-0" />
        <span>{opt.label}</span>
        {#snippet trailing()}
          {#if permissionMode === opt.id}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
        {/snippet}
      </DropdownItem>
    {/each}
  </div>
</Dropdown>
