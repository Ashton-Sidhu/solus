<script lang="ts">
  import { CaretDownIcon, CheckIcon, RobotIcon } from 'phosphor-svelte'
  import { getAgentContext } from '../../contexts/agent.context.svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import { getStatusBarContext } from '../../contexts/status-bar.context.svelte'
  import { agentLabel, buildAgentAvailabilityRows } from '../../lib/agentAvailability'
  import { tooltip } from '../../lib/tooltip'
  import { requestInputFocus } from '../../lib/inputFocus'
  import Dropdown from '../ui/Dropdown.svelte'
  import DropdownItem from '../ui/DropdownItem.svelte'

  interface Props {
    compact?: boolean;
  }
  let { compact = false }: Props = $props();

  const agentContext = getAgentContext()
  const session = getWorkspaceContext()
  const statusBar = getStatusBarContext()

  const activeAgentId = $derived(statusBar.ctx.activeAgent)
  const activeLabel = $derived(agentLabel(activeAgentId, agentContext.metadata))
  const allAgentRows = $derived(buildAgentAvailabilityRows(agentContext.agents, agentContext.metadata))
  const agentRows = $derived(allAgentRows.filter((agent) => agent.enabled))

  let open = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)

  $effect(() => {
    const active = allAgentRows.find((agent) => agent.id === activeAgentId)
    if (!active || active.enabled) return
    const fallback = allAgentRows.find((agent) => agent.enabled)
    if (fallback) session.switchActiveAgent(fallback.id)
  })

  function selectAgent(agentId: string) {
    session.switchActiveAgent(agentId)
    open = false
    requestInputFocus()
  }
</script>

<button
  bind:this={triggerEl}
  onclick={() => { open = !open }}
  aria-keyshortcuts="Alt+Shift+G"
  class="flex items-center gap-0.5 text-[0.75rem] rounded-full px-2 py-0.5 transition-[background-color,color,scale] text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)] hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)"
  use:tooltip={open ? null : (compact ? activeLabel : "Select agent (Opt+Shift+G)")}
>
  {#if compact}
    <RobotIcon size={12} />
  {:else}
    {activeLabel}
  {/if}
  <CaretDownIcon size={10} style="opacity:0.6" />
</button>

<Dropdown bind:open {triggerEl} align="bottom" anchor="right" width={160}>
  <div class="py-1">
    {#each agentRows as agent (agent.id)}
      <DropdownItem
        selected={agent.id === activeAgentId}
        onclick={() => selectAgent(agent.id)}
      >
        <span class="min-w-0 truncate">{agent.label}</span>
        {#snippet trailing()}
          {#if agent.id === activeAgentId}<CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />{/if}
        {/snippet}
      </DropdownItem>
    {/each}
  </div>
</Dropdown>
