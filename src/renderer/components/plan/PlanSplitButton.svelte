<script lang="ts">
  import { CheckIcon, CaretDownIcon } from 'phosphor-svelte'
  import { getAgentContext } from '../../contexts/agent.context.svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import { MODEL_PROFILES, type AgentId } from '../../../shared/types'

  interface Props {
    label: string
    mode: 'ask' | 'auto'
    planId: string
    compact?: boolean
    variant: 'primary' | 'accent-soft'
    kbdHint: string
    actionComment: string
    useWorktree?: boolean
    onDone?: () => void
  }

  let { label, mode, planId, compact = false, variant, kbdHint, actionComment, useWorktree, onDone }: Props = $props()

  const session = getWorkspaceContext()
  const agentContext = getAgentContext()

  let open = $state(false)

  const sess = $derived(session.sessionFor(session.activeTabId))
  const currentProvider = $derived(sess?.provider ?? null)
  const currentModelId = $derived(sess?.modelConfig.modelId ?? null)

  interface ModelEntry {
    provider: AgentId
    providerLabel: string
    modelId: string
    modelLabel: string
  }

  const allModels = $derived.by(() => {
    const entries: ModelEntry[] = []
    for (const agent of agentContext.agents) {
      if (agentContext.metadata[agent.id]?.available !== true) continue
      const profiles = MODEL_PROFILES[agent.id]
      if (!profiles) continue
      for (const [modelId, profile] of Object.entries(profiles)) {
        entries.push({
          provider: agent.id,
          providerLabel: agent.label,
          modelId,
          modelLabel: profile.label,
        })
      }
    }
    return entries
  })

  const providers = $derived.by(() => {
    const seen = new Set<AgentId>()
    const result: Array<{ id: AgentId; label: string }> = []
    for (const m of allModels) {
      if (seen.has(m.provider)) continue
      seen.add(m.provider)
      result.push({ id: m.provider, label: m.providerLabel })
    }
    return result
  })

  const sizeClass = $derived(compact ? 'plan-split--compact' : '')

  function handleMainClick() {
    session.approvePlanWithModel(planId, mode, currentProvider ?? undefined, currentModelId ?? undefined, actionComment || undefined, useWorktree)
    onDone?.()
  }

  function handleModelSelect(provider: AgentId, modelId: string) {
    open = false
    session.approvePlanWithModel(planId, mode, provider, modelId, actionComment || undefined, useWorktree)
    onDone?.()
  }
</script>

<div class="plan-split-wrap {sizeClass}">
  <button
    type="button"
    onclick={handleMainClick}
    data-testid="plan-action-yes-auto"
    class="plan-split-main plan-split-main--{variant} {sizeClass} flex items-center gap-1"
  >
    <CheckIcon size={compact ? 12 : 14} />
    {label}
    <span class="plan-split-kbd">{kbdHint}</span>
  </button>
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button {...props} type="button" class="plan-split-caret plan-split-caret--{variant} {sizeClass}" aria-label="Choose model to implement plan">
          <CaretDownIcon size={10} />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[220px]">
      {#each providers as prov (prov.id)}
        <DropdownMenu.Group>
          <DropdownMenu.GroupHeading class="plan-split-provider-header">{prov.label}</DropdownMenu.GroupHeading>
          {#each allModels.filter(m => m.provider === prov.id) as m (m.modelId)}
            {@const isActive = m.provider === currentProvider && m.modelId === currentModelId}
            <DropdownMenu.Item onSelect={() => handleModelSelect(m.provider, m.modelId)} class={isActive ? "font-semibold" : undefined}>
              <span class="flex-1 truncate">{m.modelLabel}</span>
              {#if isActive}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Group>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>

<style>
  .plan-split-wrap {
    display: inline-flex;
    height: 1.875rem;
    border-radius: 0.375rem;
    overflow: hidden;
    box-sizing: border-box;
  }
  .plan-split--compact.plan-split-wrap {
    height: 1.875rem;
    border-radius: 0.375rem;
  }

  .plan-split-kbd {
    font-size: 0.5625rem;
    opacity: 0.45;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
    margin-left: 0.125rem;
    font-variant-numeric: tabular-nums;
  }

  /* Main button */
  .plan-split-main {
    height: 1.875rem;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0 0.625rem;
    border: 0.0625rem solid transparent;
    border-right: none;
    border-radius: 0.375rem 0 0 0.375rem;
    cursor: pointer;
    box-sizing: border-box;
    transition: background var(--duration-quick) var(--ease-premium),
                color var(--duration-quick) var(--ease-premium),
                transform 80ms var(--ease-premium);
  }
  .plan-split-main.plan-split--compact {
    height: 1.875rem;
    font-size: 0.8rem;
    padding: 0 0.625rem;
    border-radius: 0.375rem 0 0 0.375rem;
  }
  .plan-split-main:active {
    transform: scale(0.97);
  }

  /* Caret button */
  .plan-split-caret {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 1.875rem;
    width: 1.375rem;
    border: 0.0625rem solid transparent;
    border-left: none;
    border-radius: 0 0.375rem 0.375rem 0;
    cursor: pointer;
    box-sizing: border-box;
    transition: background var(--duration-quick) var(--ease-premium),
                filter var(--duration-quick) var(--ease-premium);
    position: relative;
  }
  .plan-split-caret.plan-split--compact {
    height: 1.875rem;
    width: 1.375rem;
    border-radius: 0 0.375rem 0.375rem 0;
  }
  .plan-split-caret::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.25rem;
    bottom: 0.25rem;
    width: 0.0625rem;
    opacity: 0.25;
  }

  /* accent-soft variant */
  .plan-split-main--accent-soft {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    border-color: var(--solus-accent-border);
  }
  .plan-split-main--accent-soft:hover {
    background: var(--solus-accent-soft);
    border-color: var(--solus-accent-border-medium);
  }
  .plan-split-caret--accent-soft {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    border-color: var(--solus-accent-border);
  }
  .plan-split-caret--accent-soft:hover {
    background: var(--solus-accent-soft);
    border-color: var(--solus-accent-border-medium);
  }
  .plan-split-caret--accent-soft::before {
    background: var(--solus-accent);
  }

  /* primary variant */
  .plan-split-main--primary {
    background: var(--solus-accent);
    color: #fff;
    box-shadow:
      0 0.0625rem 0.125rem rgba(217, 119, 87, 0.25),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.10);
  }
  .plan-split-main--primary:hover {
    background: var(--solus-send-hover);
    box-shadow:
      0 0.125rem 0.5rem rgba(217, 119, 87, 0.32),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.12);
  }
  .plan-split-caret--primary {
    background: var(--solus-accent);
    color: #fff;
    box-shadow:
      0 0.0625rem 0.125rem rgba(217, 119, 87, 0.25),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.10);
  }
  .plan-split-caret--primary:hover {
    background: var(--solus-send-hover);
    box-shadow:
      0 0.125rem 0.5rem rgba(217, 119, 87, 0.32),
      inset 0 0 0 0.0625rem rgba(255, 255, 255, 0.12);
  }
  .plan-split-caret--primary::before {
    background: rgba(255, 255, 255, 0.3);
  }

  /* Focus styles */
  .plan-split-main:focus-visible,
  .plan-split-caret:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }


  .plan-split-provider-header {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--solus-text-tertiary);
    padding: 0.5rem 0.75rem 0.1875rem;
  }

  .plan-split-model-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3125rem 0.75rem;
    font-size: 0.6875rem;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .plan-split-model-row:hover {
    background: var(--solus-accent-light);
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
