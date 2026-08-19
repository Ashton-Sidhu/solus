<script lang="ts">
  import type { Snippet } from 'svelte'
  import { fly } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import Icon from '@iconify/svelte'
  import type { DiagramNode } from '../../../../shared/diagram-types'
  import { resolveIcon } from '../diagram-icons'
  import { INSPECTOR_TABS, type InspectorTab } from '../lib/inspector-model'

  // Svelte transitions don't consult prefers-reduced-motion on their own —
  // zero the durations so reduced-motion users get an instant swap.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  interface Props {
    node: DiagramNode
    tab: InspectorTab
    onTabChange: (tab: InspectorTab) => void
    /** Degree of the node, shown as a chip whether or not it has any edges. */
    degree: { in: number; out: number }
    hasDetail: boolean
    /** Unresolved threads on this node — the count beside the Comments tab. */
    threadCount: number
    /** Live save state, mirrored from the shell. */
    saveState: string
    onCollapse: () => void
    onClose: () => void
    onDelete: () => void
    // Focus the label input on mount — set only when the inspector is opened via
    // an explicit edit intent, so plain selection leaves focus on the canvas.
    autoFocus?: boolean
    children: Snippet
  }

  let {
    node,
    tab,
    onTabChange,
    degree,
    hasDetail,
    threadCount,
    saveState,
    onCollapse,
    onClose,
    onDelete,
    autoFocus = false,
    children,
  }: Props = $props()

  const isGroup = $derived(!!node.group)
  const isEntity = $derived(!!node.fields?.length && !node.group)
  const resolved = $derived(resolveIcon(node.icon, isEntity ? 'table' : 'service'))
  // The identity tile is the ONE place a node's colour appears — the card body
  // on canvas stays neutral so a graph reads as structure, not as a palette.
  const tint = $derived(node.color ?? 'var(--solus-accent)')

  const TAB_LABELS = {
    identity: 'Identity',
    style: 'Style',
    data: 'Data',
    links: 'Links',
    comments: 'Comments',
  } satisfies Record<InspectorTab, string>

  let panelEl = $state<HTMLDivElement | undefined>()

  $effect(() => {
    // Tracked so adding two nodes in a row focuses the second one's label too —
    // the panel stays mounted across the switch, so `autoFocus` alone never
    // changes and would only ever fire once.
    void node.id
    if (autoFocus && panelEl) {
      panelEl.querySelector<HTMLElement>('.inspector-name-input')?.focus()
    }
  })
</script>

<!-- `|global` so the transitions also play when the parent's {#if} removes the
     whole component, not just this element's own block. -->
<div
  class="diagram-inspector"
  bind:this={panelEl}
  role="complementary"
  aria-label="Edit {isGroup ? 'group' : 'node'}: {node.label}"
  in:fly|global={{ x: 24, duration: reduceMotion ? 0 : 200, easing: quintOut }}
  out:fly|global={{ x: 12, duration: reduceMotion ? 0 : 140, easing: quintOut }}
>
  <div class="diagram-inspector__head">
    <div class="diagram-inspector__identity">
      <span
        class="diagram-inspector__tile"
        style="--tile-tint:{tint}"
        aria-hidden="true"
      >
        {#if resolved.iconify}
          <Icon icon={resolved.iconify} width="18" height="18" />
        {:else if resolved.svg}
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
            {@html resolved.svg}
          </svg>
        {:else}
          {resolved.emoji}
        {/if}
        {#if hasDetail}
          <!-- Nest corner: present iff this node owns a nested graph. -->
          <span class="diagram-inspector__nest">
            <svg viewBox="0 0 16 16" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.9">
              <rect x="2" y="5" width="9" height="9" rx="2" />
              <path d="M5 5V3.5A1.5 1.5 0 0 1 6.5 2h6A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H11" />
            </svg>
          </span>
        {/if}
      </span>

      <div class="diagram-inspector__titles">
        <span class="diagram-inspector__title">{node.label}</span>
        {#if node.subtitle}
          <span class="diagram-inspector__sub">{node.subtitle}</span>
        {/if}
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
      <span class="diagram-inspector__chip">{degree.in} in · {degree.out} out</span>
      {#if hasDetail}
        <span class="diagram-inspector__chip diagram-inspector__chip--accent">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <rect x="2" y="5" width="9" height="9" rx="2" />
            <path d="M5 5V3.5A1.5 1.5 0 0 1 6.5 2h6A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H11" />
          </svg>
          detail diagram
        </span>
      {/if}
    </div>
  </div>

  <div class="diagram-inspector__tabs" role="tablist" aria-label="Inspector sections">
    {#each INSPECTOR_TABS as name (name)}
      <button
        type="button"
        role="tab"
        id="diagram-node-tab-{name}"
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

  <!-- Keyed on the tab so each section rises in on its own. The tab contents are
       already mounted per-tab by an {#if}, so this costs no extra churn. -->
  <div class="diagram-inspector__body" role="tabpanel" aria-labelledby="diagram-node-tab-{tab}">
    {#key tab}
      <div class="diagram-inspector__panel">
        {@render children()}
      </div>
    {/key}
  </div>

  <!-- Edits are live: there is no Save button, only a save-state read-out. -->
  <div class="diagram-inspector__foot">
    <button type="button" class="diagram-inspector__delete" onclick={onDelete}>
      Delete {isGroup ? 'group' : 'node'}
    </button>
    <div class="diagram-inspector__foot-spacer"></div>
    <span class="diagram-inspector__save">{saveState}</span>
  </div>
</div>
