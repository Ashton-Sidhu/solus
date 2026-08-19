<script lang="ts">
  import type { DiagramNode } from '@solus/contracts/diagram-types'
  import DiagramInspector from './DiagramInspector.svelte'
  import IdentityTab from './IdentityTab.svelte'
  import StyleTab from './StyleTab.svelte'
  import DataTab from './DataTab.svelte'
  import LinksTab from './LinksTab.svelte'
  import CommentsTab from './CommentsTab.svelte'
  import type { PlanComment } from '@solus/contracts/types'
  import { isResolved } from '../../comments/lib/thread'
  import { nodeDegree, type InspectorTab, type NodeLink } from '../lib/inspector-model'

  interface Props {
    node: DiagramNode
    links: NodeLink[]
    tab: InspectorTab
    onTabChange: (tab: InspectorTab) => void
    saveState: string
    autoFocus?: boolean
    onUpdateNode: (id: string, patch: Partial<DiagramNode>) => void
    onCollapse: () => void
    onClose: () => void
    onDelete: () => void
    onOpenEdge: (edgeId: string) => void
    canDetail: boolean
    hasDetail: boolean
    onOpenDetail: () => void
    onRemoveDetail: () => void
    /** Threads anchored to this node. */
    threads: PlanComment[]
    diagramThreadCount: number
    showResolved: boolean
    onShowResolvedChange: (show: boolean) => void
    onOpenThread: (commentId: string) => void
    onShowAllThreads: () => void
    now: number
  }

  let {
    node,
    links,
    tab,
    onTabChange,
    saveState,
    autoFocus = false,
    onUpdateNode,
    onCollapse,
    onClose,
    onDelete,
    onOpenEdge,
    canDetail,
    hasDetail,
    onOpenDetail,
    onRemoveDetail,
    threads,
    diagramThreadCount,
    showResolved,
    onShowResolvedChange,
    onOpenThread,
    onShowAllThreads,
    now,
  }: Props = $props()

  const degree = $derived(nodeDegree(links))
  // The tab count is about work still outstanding, so resolved threads don't
  // keep the badge lit after the conversation is settled.
  const threadCount = $derived(threads.filter((t) => !isResolved(t)).length)
</script>

<DiagramInspector
  {node}
  {tab}
  {onTabChange}
  {degree}
  {hasDetail}
  {threadCount}
  {saveState}
  {autoFocus}
  {onCollapse}
  {onClose}
  {onDelete}
>
  {#if tab === 'identity'}
    <IdentityTab {node} {onUpdateNode} />
  {:else if tab === 'style'}
    <StyleTab {node} {onUpdateNode} />
  {:else if tab === 'data'}
    <DataTab {node} {onUpdateNode} />
  {:else if tab === 'links'}
    <LinksTab
      {node}
      {links}
      {onUpdateNode}
      {onOpenEdge}
      {canDetail}
      {hasDetail}
      {onOpenDetail}
      {onRemoveDetail}
    />
  {:else}
    <CommentsTab
      {threads}
      anchorKind="node"
      {diagramThreadCount}
      {showResolved}
      {onShowResolvedChange}
      {onOpenThread}
      onShowAll={onShowAllThreads}
      {now}
    />
  {/if}
</DiagramInspector>
