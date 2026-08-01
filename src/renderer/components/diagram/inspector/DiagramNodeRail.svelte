<script lang="ts">
  import Icon from '@iconify/svelte'
  import type { DiagramNode } from '../../../../shared/diagram-types'
  import { resolveIcon } from '../diagram-icons'
  import DiagramInspectorRail from './DiagramInspectorRail.svelte'
  import { INSPECTOR_TABS, railKindWord, type InspectorTab } from '../lib/inspector-model'

  interface Props {
    node: DiagramNode
    tab: InspectorTab
    hasUnreadThreads: boolean
    onExpand: (tab?: InspectorTab) => void
  }

  let { node, tab, hasUnreadThreads, onExpand }: Props = $props()

  const isEntity = $derived(!!node.fields?.length && !node.group)
  const resolved = $derived(resolveIcon(node.icon, isEntity ? 'table' : 'service'))
  const tint = $derived(node.color ?? 'var(--solus-accent)')
</script>

<DiagramInspectorRail
  kindWord={railKindWord(node)}
  label={node.label}
  {tint}
  tabs={INSPECTOR_TABS}
  {tab}
  {hasUnreadThreads}
  onExpand={(name) => onExpand(name as InspectorTab | undefined)}
>
  {#snippet tile()}
    {#if resolved.iconify}
      <Icon icon={resolved.iconify} width="16" height="16" />
    {:else if resolved.svg}
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
        {@html resolved.svg}
      </svg>
    {:else}
      {resolved.emoji}
    {/if}
  {/snippet}
</DiagramInspectorRail>
