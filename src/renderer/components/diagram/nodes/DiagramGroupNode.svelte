<script lang="ts">
  import { Handle, Position, NodeResizer } from '@xyflow/svelte'
  import Icon from '@iconify/svelte'
  import type { DiagramNode } from '../../../../shared/diagram-types'
  import { resolveIcon } from '../diagram-icons'
  import { EditableLabel } from '../editable-label.svelte'
  import { ensureIconCollections } from '../iconify'

  // Code-split, idempotent brand-icon registration (see DiagramNode).
  ensureIconCollections()

  interface NodeData extends DiagramNode {
    dimmed?: boolean
    onLabelChange?: (id: string, label: string) => void
    onResize?: (id: string, width: number, height: number) => void
    onResizeLive?: (
      id: string,
      params: { x: number; y: number; width: number; height: number },
    ) => void
    onContextMenu?: (id: string, type: 'node' | 'edge', x: number, y: number) => void
    onSelect?: (id: string) => void
    onToggleCollapse?: (id: string) => void
  }

  interface Props {
    data: NodeData
    selected?: boolean
  }

  let { data, selected = false }: Props = $props()

  // Groups default to the curated container glyph rather than a service icon.
  const resolved = $derived(resolveIcon(data.icon, 'group'))

  const editor = new EditableLabel({
    getLabel: () => data.label,
    onCommit: (v) => data.onLabelChange?.(data.id, v),
  })

  function handleClick() {
    if (editor.editing) return
    data.onSelect?.(data.id)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'F2') editor.start(e)
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    }
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    data.onContextMenu?.(data.id, 'node', e.clientX, e.clientY)
  }

  function handleCollapseClick(e: MouseEvent) {
    e.stopPropagation()
    data.onToggleCollapse?.(data.id)
  }
</script>

<!-- Resizing a collapsed group is meaningless (the box is shrunk to its header),
     so the resize handles are hidden until it's expanded again. -->
{#if !data.collapsed}
  <NodeResizer
    minWidth={220}
    minHeight={140}
    isVisible={true}
    color="transparent"
    lineClass="node-resize-line"
    handleClass="node-resize-handle"
    onResize={(_event, params) => {
      data.onResizeLive?.(data.id, {
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
      })
    }}
    onResizeEnd={(_event, params) => {
      data.onResize?.(data.id, params.width, params.height)
    }}
  />
{/if}

<!-- Same 8 edge anchors as the regular node so groups are connectable. As
     there, the source half of each side's stacked pair renders last (topmost)
     so drags from any side start a forward edge. -->
<Handle type="target" position={Position.Left} id="l-target" />
<Handle type="source" position={Position.Left} id="l-source" />
<Handle type="target" position={Position.Top} id="t-target" />
<Handle type="source" position={Position.Top} id="t-source" />

<div
  class="diagram-group"
  class:diagram-group--selected={selected}
  class:diagram-group--dimmed={data.dimmed}
  class:diagram-group--collapsed={data.collapsed}
  style={data.color ? `--group-accent:${data.color}` : undefined}
  role="button"
  tabindex="0"
  aria-label="Select group {data.label}"
  ondblclick={editor.start}
  onclick={handleClick}
  onkeydown={handleKeydown}
  oncontextmenu={handleContextMenu}
>
  <div class="diagram-group__head">
    <button
      type="button"
      class="diagram-group__collapse"
      onclick={handleCollapseClick}
      aria-expanded={!data.collapsed}
      title={data.collapsed ? 'Expand group' : 'Collapse group'}
      aria-label={data.collapsed ? 'Expand group' : 'Collapse group'}
    >
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d={data.collapsed ? 'M6 4l4 4-4 4' : 'M4 6l4 4 4-4'} />
      </svg>
    </button>
    <span class="diagram-group__icon" aria-hidden="true">
      {#if resolved.iconify}
        <Icon icon={resolved.iconify} width="18" height="18" />
      {:else if resolved.svg}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {@html resolved.svg}
        </svg>
      {:else}
        {resolved.emoji}
      {/if}
    </span>

    {#if editor.editing}
      <input
        bind:this={editor.inputEl}
        bind:value={editor.value}
        class="diagram-group__input"
        onblur={editor.commit}
        onkeydown={editor.onInputKeydown}
        onclick={(e) => e.stopPropagation()}
      />
    {:else}
      <span class="diagram-group__label">{data.label}</span>
    {/if}
  </div>
</div>

<Handle type="target" position={Position.Right} id="r-target" />
<Handle type="source" position={Position.Right} id="r-source" />
<Handle type="target" position={Position.Bottom} id="b-target" />
<Handle type="source" position={Position.Bottom} id="b-source" />

<style>
  .diagram-group {
    --group-accent: var(--solus-accent);
    --group-radius: 1rem;
    position: relative;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 13.75rem;
    min-height: 8.75rem;
    border-radius: var(--group-radius);
    /* Subtle tinted, translucent fill so child cards read clearly on top. */
    border: 0.0625rem solid color-mix(in srgb, var(--group-accent) 28%, transparent);
    background: color-mix(in srgb, var(--group-accent) 6%, var(--solus-container-bg));
    /* Sit below child nodes so they render on top of the container. */
    z-index: 0;
    cursor: grab;
    user-select: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.2s ease;
  }

  .diagram-group:hover {
    border-color: var(--solus-accent-border-medium);
  }

  .diagram-group:active { cursor: grabbing; }

  /* While dragged, the group is lifted above every node (DRAG_Z) so it tracks
     on top — which would otherwise let its opaque fill hide any node it passes
     over, e.g. a loose node it's being moved onto to swallow. Drop the fill to
     a pure tint for the duration so those nodes stay visible through the box
     (and the capture target reads at a glance). */
  :global(.svelte-flow__node.dragging) .diagram-group {
    background: color-mix(in srgb, var(--group-accent) 8%, transparent);
  }

  .diagram-group--selected {
    border-color: var(--solus-accent);
    box-shadow: 0 0 0 0.125rem var(--solus-accent-soft);
  }

  .diagram-group--dimmed {
    opacity: 0.28;
    filter: saturate(0.4);
    pointer-events: none;
  }

  .diagram-group:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* Header bar pinned top-left so it never overlaps nested cards below it. */
  .diagram-group__head {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    max-width: calc(100% - 1rem);
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    background: var(--solus-container-bg);
  }

  /* Collapse caret — leads the header so it reads as the group's fold toggle. */
  .diagram-group__collapse {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.125rem;
    height: 1.125rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    padding: 0;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .diagram-group__collapse:hover {
    background: color-mix(in srgb, var(--group-accent) 12%, transparent);
    color: var(--group-accent);
  }

  .diagram-group__collapse:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* A collapsed group is just its header chip, so drop the container tint/fill
     and let the header read as the whole node. */
  .diagram-group--collapsed {
    border-style: dashed;
    background: transparent;
  }

  .diagram-group--collapsed .diagram-group__head {
    position: static;
    top: auto;
    left: auto;
    max-width: 100%;
    height: 100%;
    background: transparent;
  }

  .diagram-group__icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.625rem;
    height: 1.625rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--group-accent) 14%, transparent);
    color: var(--group-accent);
    font-size: 1rem;
    line-height: 1;
  }

  .diagram-group__label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--solus-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .diagram-group__input {
    min-width: 0;
    background: transparent;
    border: none;
    border-bottom: 0.09375rem solid var(--solus-accent-border);
    outline: none;
    color: var(--solus-text-primary);
    font-size: 0.8125rem;
    font-weight: 600;
    padding: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .diagram-group { transition: none; }
  }
</style>
