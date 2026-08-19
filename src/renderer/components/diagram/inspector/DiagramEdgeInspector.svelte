<script lang="ts">
  import { fly } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import type { DiagramEdge } from '../../../../shared/diagram-types'
  import type { PlanComment } from '../../../../shared/types'
  import { isResolved } from '../../comments/lib/thread'
  import {
    EDGE_INSPECTOR_TABS,
    edgeKindLabel,
    edgeRouteLabel,
    type EdgeInspectorTab,
    type EdgeUpdates,
  } from '../lib/inspector-model'
  import EdgeIdentityTab from './EdgeIdentityTab.svelte'
  import EdgeStyleTab from './EdgeStyleTab.svelte'
  import EdgeRouteTab from './EdgeRouteTab.svelte'
  import CommentsTab from './CommentsTab.svelte'

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  interface Props {
    edge: Pick<
      DiagramEdge,
      | 'id'
      | 'source'
      | 'target'
      | 'label'
      | 'body'
      | 'kind'
      | 'color'
      | 'width'
      | 'dash'
      | 'arrows'
      | 'route'
      | 'cardinality'
    >
    sourceLabel: string
    targetLabel: string
    tab: EdgeInspectorTab
    onTabChange: (tab: EdgeInspectorTab) => void
    /** How many edges leave this edge's source — a fan-out shares one trunk. */
    trunkSiblings: number
    saveState: string
    autoFocus?: boolean
    update: EdgeUpdates
    /** Select the node at one end and hand the rail back to the node inspector. */
    onOpenEndpoint: (nodeId: string) => void
    onReverse: () => void
    onCollapse: () => void
    onClose: () => void
    onDelete: () => void
    threads: PlanComment[]
    diagramThreadCount: number
    showResolved: boolean
    onShowResolvedChange: (show: boolean) => void
    onOpenThread: (commentId: string) => void
    onShowAllThreads: () => void
    now: number
  }

  let {
    edge,
    sourceLabel,
    targetLabel,
    tab,
    onTabChange,
    trunkSiblings,
    saveState,
    autoFocus = false,
    update,
    onOpenEndpoint,
    onReverse,
    onCollapse,
    onClose,
    onDelete,
    threads,
    diagramThreadCount,
    showResolved,
    onShowResolvedChange,
    onOpenThread,
    onShowAllThreads,
    now,
  }: Props = $props()

  const TAB_LABELS = {
    identity: 'Identity',
    style: 'Style',
    route: 'Route',
    comments: 'Comments',
  } satisfies Record<EdgeInspectorTab, string>

  // An edge only takes a tint when it means something; otherwise it borrows the
  // selection colour so the header still reads as one family with the node panel.
  const tint = $derived(edge.color ?? 'var(--solus-accent)')
  // Both read from the same tables the Identity and Route tabs render, lowercased
  // for the sub-line and the mono chip — never a second spelling of the enum.
  const relationship = $derived(edgeKindLabel(edge.kind).toLowerCase())
  const subtitle = $derived(edge.label ? `${relationship} · ${edge.label}` : relationship)
  const routeChip = $derived(edgeRouteLabel(edge.route).toLowerCase())
  const threadCount = $derived(threads.filter((t) => !isResolved(t)).length)

  let panelEl = $state<HTMLDivElement | undefined>()

  $effect(() => {
    void edge.id
    if (autoFocus && panelEl) {
      panelEl.querySelector<HTMLElement>('.inspector-name-input')?.focus()
    }
  })
</script>

<div
  class="diagram-inspector"
  bind:this={panelEl}
  role="complementary"
  aria-label="Edit edge: {sourceLabel} to {targetLabel}"
  in:fly|global={{ x: 24, duration: reduceMotion ? 0 : 200, easing: quintOut }}
  out:fly|global={{ x: 12, duration: reduceMotion ? 0 : 140, easing: quintOut }}
>
  <div class="diagram-inspector__head">
    <div class="diagram-inspector__identity">
      <span class="diagram-inspector__tile" style="--tile-tint:{tint}" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 4h4a2 2 0 0 1 2 2v5.4M7.6 9.4l2 2 2-2" />
          <circle cx="3.6" cy="4" r="1.4" />
        </svg>
      </span>

      <!-- Each end truncates independently around the arrow, so a long source
           name can never eat the target's. -->
      <div class="diagram-inspector__titles">
        <div class="edge-title">
          <span class="edge-title__end">{sourceLabel}</span>
          <span class="edge-title__arrow" aria-hidden="true">→</span>
          <span class="edge-title__end">{targetLabel}</span>
        </div>
        <span class="diagram-inspector__sub">{subtitle}</span>
      </div>

      <div class="diagram-inspector__actions">
        <button
          type="button"
          class="diagram-inspector__icon-btn"
          onclick={onCollapse}
          title="Collapse to rail (⌘\)"
          aria-label="Collapse inspector"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <path d="M13.5 3v10M4 8h6.5M7 5l3 3-3 3" />
          </svg>
        </button>
        <button
          type="button"
          class="diagram-inspector__icon-btn"
          onclick={onClose}
          title="Close (Esc)"
          aria-label="Close inspector"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>

    <div class="diagram-inspector__chips">
      <span class="diagram-inspector__chip">{routeChip}</span>
      {#if trunkSiblings > 1}
        <!-- Siblings share the trunk x, so three edges read as one branch. -->
        <span class="diagram-inspector__chip diagram-inspector__chip--accent">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M3 8h4M7 8v-4h6M7 8v4h6" />
          </svg>
          shares trunk with {trunkSiblings - 1}
        </span>
      {/if}
    </div>
  </div>

  <div class="diagram-inspector__tabs" role="tablist" aria-label="Edge sections">
    {#each EDGE_INSPECTOR_TABS as name (name)}
      <button
        type="button"
        role="tab"
        id="diagram-edge-tab-{name}"
        class="diagram-inspector__tab"
        class:diagram-inspector__tab--active={tab === name}
        aria-selected={tab === name}
        onclick={() => onTabChange(name)}
      >
        {TAB_LABELS[name]}
        {#if name === 'comments' && threadCount > 0}
          <span class="diagram-inspector__tab-count">{threadCount}</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="diagram-inspector__body" role="tabpanel" aria-labelledby="diagram-edge-tab-{tab}">
    <!-- Keyed on the tab so each section rises in on its own; the {#if} below
         already remounts per tab, so the key costs nothing extra. -->
    {#key tab}
      <div class="diagram-inspector__panel">
        {#if tab === 'identity'}
          <EdgeIdentityTab {edge} {update} />
        {:else if tab === 'style'}
          <EdgeStyleTab {edge} {update} />
        {:else if tab === 'route'}
          <EdgeRouteTab {edge} {sourceLabel} {targetLabel} {update} {onOpenEndpoint} {onReverse} />
        {:else}
          <CommentsTab
            {threads}
            anchorKind="edge"
            {diagramThreadCount}
            {showResolved}
            {onShowResolvedChange}
            {onOpenThread}
            onShowAll={onShowAllThreads}
            {now}
          />
        {/if}
      </div>
    {/key}
  </div>

  <div class="diagram-inspector__foot">
    <button type="button" class="diagram-inspector__delete" onclick={onDelete}>Delete edge</button>
    <div class="diagram-inspector__foot-spacer"></div>
    <span class="diagram-inspector__save">{saveState}</span>
  </div>
</div>

<style>
  /* The panel chrome lives in DiagramShell.css: this panel and the node
     inspector are the same shell, so the geometry has one source. Only the
     two-ended title is the edge panel’s own. */
  .edge-title {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .edge-title__end {
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1.3;
    color: var(--solus-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .edge-title__arrow {
    flex: none;
    font-size: var(--text-sm);
    color: var(--solus-accent);
  }
</style>
