<script lang="ts">
  import { CaretDownIcon, CheckIcon, RobotIcon } from 'phosphor-svelte'
  import { getAgentContext } from '../../contexts/agent.context.svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import { getStatusBarContext } from '../../contexts/status-bar.context.svelte'
  import { agentLabel, buildAgentAvailabilityRows } from '../../lib/agentAvailability'
  import { tooltip } from '../../lib/tooltip'
  import { requestInputFocus } from '../../lib/inputFocus'
  import * as DropdownMenu from '../ui/dropdown-menu'

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

<DropdownMenu.Root bind:open onOpenChange={(next) => { if (!next) requestInputFocus() }}>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        aria-keyshortcuts="Alt+Shift+G"
        class="flex items-center gap-0.5 text-[0.75rem] rounded-full px-2 py-0.5 transition-[background-color,color,scale] text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)"
        use:tooltip={open ? null : (compact ? activeLabel : "Select agent (Opt+Shift+G)")}
      >
        {#if compact}<RobotIcon size={12} />{:else}{activeLabel}{/if}
        <CaretDownIcon size={10} style="opacity:0.6" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[160px]">
    <DropdownMenu.RadioGroup value={activeAgentId}>
      {#each agentRows as agent (agent.id)}
        <DropdownMenu.RadioItem value={agent.id} onSelect={() => selectAgent(agent.id)}>
          <span class="min-w-0 truncate">{agent.label}</span>
          {#if agent.id === activeAgentId}<CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />{/if}
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
