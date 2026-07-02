<script lang="ts">
  import { Handle, Position, NodeResizer } from '@xyflow/svelte'
  import Icon from '@iconify/svelte'
  import type { DiagramNode, DiagramAction } from '../../../../shared/diagram-types'
  import { sanitizeNodeHtml, isSafeUrl } from '../../../../shared/diagram-sanitize'
  import { resolveIcon } from '../diagram-icons'
  import { STATUS_COLORS } from '../diagram-colors'
  import { EditableLabel } from '../editable-label.svelte'
  import { ensureIconCollections } from '../iconify'
  import { isDecorativeNodeShape, isSimpleShapeNode } from '../diagram-node-shapes'

  // Kick off the (code-split, idempotent) brand-icon registration on first node
  // mount, so the ~12MB icon sets stay out of the eager startup bundle.
  ensureIconCollections()

  interface NodeData extends DiagramNode {
    expanded?: boolean
    dimmed?: boolean
    resizable?: boolean
    onLabelChange?: (id: string, label: string) => void
    onAction?: (nodeId: string, action: DiagramAction) => void
    onResize?: (id: string, width: number, height: number) => void
    onContextMenu?: (id: string, type: 'node' | 'edge', x: number, y: number) => void
    // Open the editor side menu for this node. Driven from the node's own click
    // handler so it fires for any click on the card — including over inner
    // controls that stopPropagation (which would otherwise block xyflow's
    // onnodeclick). Absent in read-only contexts (e.g. thumbnails).
    onSelect?: (id: string) => void
  }

  interface Props {
    data: NodeData
    selected?: boolean
  }

  let { data, selected = false }: Props = $props()

  // Presence of `fields` (on a non-group node) makes this a data-model entity:
  // it renders an always-visible field table and defaults to a table glyph.
  const isEntity = $derived(!!data.fields?.length && !data.group)
  const KEY_GLYPH = { pk: 'PK', fk: 'FK', unique: 'UQ' } as const
  const KEY_TITLE = { pk: 'Primary key', fk: 'Foreign key', unique: 'Unique' } as const

  const resolved = $derived(resolveIcon(data.icon, isEntity ? 'table' : 'service'))
  const iconifyName = $derived(resolved.iconify)
  const iconSvg = $derived(resolved.svg)
  const iconEmoji = $derived(resolved.emoji)

  // Card outline. 'rectangle' is the default (the rounded card); circle/diamond
  // are decorative modifiers that only apply to a simple label node.
  const shape = $derived(
    isDecorativeNodeShape(data.shape) && !isSimpleShapeNode(data) ? 'rectangle' : (data.shape ?? 'rectangle')
  )

  const statusColor = $derived(data.status ? (STATUS_COLORS[data.status] ?? null) : null)
  const statusLabel = $derived(data.status ? data.status.charAt(0).toUpperCase() + data.status.slice(1) : '')

  const primaryAction = $derived(
    data.actions?.find((a) => a.on === 'click' && a.action.do !== 'openFile')?.action ?? null
  )
  // A node carrying a `detail` sub-diagram drills in on click — this takes
  // precedence over any other primary action.
  const drillable = $derived(!!(data.detail?.nodes?.length))
  const hasExpandable = $derived(!!(data.body || data.html || data.metrics))

  const editor = new EditableLabel({
    getLabel: () => data.label,
    onCommit: (v) => data.onLabelChange?.(data.id, v),
  })

  function dispatch(action: DiagramAction) {
    if (action.do === 'openUrl') {
      if (isSafeUrl(action.url)) {
        data.onAction?.(data.id, action)
      }
      return
    }
    data.onAction?.(data.id, action)
  }

  function handleClick(e: MouseEvent) {
    if (editor.editing) return
    // Any click on the card opens its side menu. This runs even when a
    // primaryAction is present (which still dispatches below).
    data.onSelect?.(data.id)
    if (drillable) {
      e.stopPropagation()
      dispatch({ do: 'drilldown' })
      return
    }
    if (primaryAction) {
      e.stopPropagation()
      dispatch(primaryAction)
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'F2') { editor.start(e); return }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      data.onSelect?.(data.id)
      if (drillable) { dispatch({ do: 'drilldown' }); return }
      if (primaryAction) dispatch(primaryAction)
    }
  }

  function handleExpandClick(e: MouseEvent) {
    e.stopPropagation()
    // Honour "clicking anywhere on the node opens the menu" — the chevron still
    // toggles expansion, but also selects so the side menu appears.
    data.onSelect?.(data.id)
    dispatch({ do: 'expand' })
  }

  // Delegated click handler for custom HTML — reads data-action attributes
  function handleContextMenu(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    data.onContextMenu?.(data.id, 'node', e.clientX, e.clientY)
  }

  function handleHtmlClick(e: MouseEvent) {
    const target = e.target as HTMLElement
    const el = target.closest('[data-action]') as HTMLElement | null
    if (!el) return
    const actionType = el.dataset.action
    const prompt = el.dataset.prompt
    const url = el.dataset.url
    if (!actionType) return
    e.stopPropagation()
    if (actionType === 'details') dispatch({ do: 'details' })
    else if (actionType === 'focus') dispatch({ do: 'focus' })
    else if (actionType === 'expand') dispatch({ do: 'expand' })
    else if (actionType === 'drilldown') dispatch({ do: 'drilldown' })
    else if (actionType === 'openUrl' && url) dispatch({ do: 'openUrl', url })
  }
</script>

{#if data.resizable !== false}
  <NodeResizer
    minWidth={192}
    maxWidth={288}
    minHeight={48}
    isVisible={true}
    color="transparent"
    lineClass="node-resize-line"
    handleClass="node-resize-handle"
    onResizeEnd={(_event, params) => {
      data.onResize?.(data.id, params.width, params.height)
    }}
  />
{/if}

  <!-- Each side stacks a target handle under a source handle; the source renders last
     (topmost) so starting a drag from any side draws a forward edge. Mid-drag,
     the shell makes same-type handles hit-transparent so drops reach the
     compatible half of the pair. -->
<Handle type="target" position={Position.Left} id="l-target" />
<Handle type="source" position={Position.Left} id="l-source" />
<Handle type="target" position={Position.Top} id="t-target" />
<Handle type="source" position={Position.Top} id="t-source" />

<div
  class="diagram-node diagram-node--{shape}"
  class:diagram-node--selected={selected}
  class:diagram-node--dimmed={data.dimmed}
  class:diagram-node--clickable={(!!primaryAction || drillable) && !editor.editing}
  class:diagram-node--drillable={drillable}
  style={data.color ? `--node-accent:${data.color}` : undefined}
  role="button"
  tabindex="0"
  aria-label="Select node {data.label}"
  ondblclick={editor.start}
  onclick={handleClick}
  onkeydown={handleKeydown}
  oncontextmenu={handleContextMenu}
>
  {#if shape === 'diamond'}
    <!-- Outline backdrop: a plain border can't survive the diamond silhouette,
         so the fill + stroke are drawn by this polygon. preserveAspectRatio=none
         lets it stretch to the card; non-scaling-stroke keeps an even edge. -->
    <svg class="diagram-node__shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="50,1 99,50 50,99 1,50" vector-effect="non-scaling-stroke" />
    </svg>
  {/if}

  <!-- Header row: icon + title/subtitle + status dot -->
  <div class="diagram-node__head">
    <span class="diagram-node__icon" aria-hidden="true">
      {#if iconifyName}
        <Icon icon={iconifyName} width="16" height="16" />
      {:else if iconSvg}
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {@html iconSvg}
        </svg>
      {:else}
        {iconEmoji}
      {/if}
    </span>

    <div class="diagram-node__title-group">
      {#if editor.editing}
        <input
          bind:this={editor.inputEl}
          bind:value={editor.value}
          class="diagram-node__input"
          onblur={editor.commit}
          onkeydown={editor.onInputKeydown}
          onclick={(e) => e.stopPropagation()}
        />
      {:else}
        <span class="diagram-node__label">{data.label}</span>
      {/if}
      {#if data.subtitle}
        <span class="diagram-node__subtitle">{data.subtitle}</span>
      {/if}
    </div>

    {#if statusColor}
      <span
        class="diagram-node__status-dot"
        style="background:{statusColor}"
        title="Status: {statusLabel}"
        aria-label="Status: {statusLabel}"
      ></span>
    {/if}

    {#if drillable}
      <span
        class="diagram-node__drill"
        title="Click to open detail"
        aria-hidden="true"
      >
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2.5" width="7" height="5" rx="1" />
          <rect x="7" y="8.5" width="7" height="5" rx="1" />
          <path d="M5.5 7.5v1.5a1 1 0 001 1h1" />
        </svg>
      </span>
    {/if}

    {#if hasExpandable}
      <button
        type="button"
        class="diagram-node__expand-btn"
        onclick={handleExpandClick}
        aria-expanded={data.expanded}
        title={data.expanded ? 'Collapse' : 'Expand'}
        aria-label={data.expanded ? 'Collapse node' : 'Expand node'}
      >
        <!-- One down-chevron rotated 180° when expanded, so the flip animates
             instead of hard-swapping between two paths. -->
        <svg class="diagram-node__expand-icon" class:diagram-node__expand-icon--open={data.expanded} viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
    {/if}
  </div>

  <!-- Badges row (always visible) -->
  {#if data.badges?.length}
    <div class="diagram-node__badges">
      {#each data.badges as badge}
        <span class="diagram-node__badge">{badge}</span>
      {/each}
    </div>
  {/if}

  <!-- Entity field table (always visible, like badges) -->
  {#if isEntity}
    <div
      class="flex flex-col gap-px mt-0.5 pt-[0.3125rem] border-t"
      style="border-top-color:color-mix(in srgb,var(--solus-text-tertiary) 14%,transparent)"
    >
      {#each data.fields ?? [] as field}
        <div class="flex items-baseline gap-1.5 text-[0.625rem] leading-[1.5] min-w-0 overflow-hidden">
          {#if field.key}
            <span
              class="shrink-0 w-[1.375rem] text-center text-[0.5rem] font-bold tracking-[0.02em] rounded-[0.1875rem] py-[0.03125rem] tabular-nums"
              title={KEY_TITLE[field.key]}
              style={
                field.key === 'pk'
                  ? 'color:var(--node-accent);background:color-mix(in srgb,var(--node-accent) 16%,transparent)'
                  : field.key === 'fk'
                  ? 'color:var(--solus-text-secondary);background:color-mix(in srgb,var(--solus-text-tertiary) 16%,transparent)'
                  : 'color:var(--solus-text-secondary);border:0.0625rem solid color-mix(in srgb,var(--solus-text-tertiary) 30%,transparent)'
              }
            >{KEY_GLYPH[field.key]}</span>
          {:else}
            <span class="shrink-0 w-[1.375rem]" aria-hidden="true"></span>
          {/if}
          <span class="flex-1 min-w-0 font-medium overflow-hidden text-ellipsis whitespace-nowrap {field.nullable ? 'text-[var(--solus-text-secondary)] italic' : 'text-[var(--solus-text-primary)]'}">{field.name}</span>
          {#if field.ref}
            <span class="shrink-0 text-[var(--solus-text-tertiary)] text-[0.5625rem] whitespace-nowrap" title="References {field.ref}">→ {field.ref}</span>
          {/if}
          {#if field.type}
            <span class="shrink min-w-0 text-[var(--solus-text-tertiary)] font-normal tabular-nums whitespace-nowrap overflow-hidden text-ellipsis" title={field.type}>{field.type}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Legacy meta (shown when no rich metrics) -->
  {#if data.meta && !data.metrics}
    <div class="diagram-node__meta-list">
      {#each Object.entries(data.meta) as [k, v]}
        <span class="diagram-node__meta"><span class="diagram-node__meta-key">{k}</span>{v}</span>
      {/each}
    </div>
  {/if}

  <!-- Expanded content: metrics + tags + body/html -->
  {#if data.expanded}
    {#if data.metrics}
      <dl class="diagram-node__metrics">
        {#each Object.entries(data.metrics) as [k, v]}
          <div class="diagram-node__metric-row">
            <dt class="diagram-node__metric-key">{k}</dt>
            <dd class="diagram-node__metric-val">{v}</dd>
          </div>
        {/each}
      </dl>
    {/if}

    {#if data.tags?.length}
      <div class="diagram-node__tags">
        {#each data.tags as tag}
          <span class="diagram-node__tag">{tag}</span>
        {/each}
      </div>
    {/if}

    {#if data.html}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="diagram-node__custom" onclick={handleHtmlClick}>
        {@html sanitizeNodeHtml(data.html)}
      </div>
    {:else if data.body}
      <p class="diagram-node__body">{data.body}</p>
    {/if}
  {/if}
</div>

<Handle type="target" position={Position.Right} id="r-target" />
<Handle type="source" position={Position.Right} id="r-source" />
<Handle type="target" position={Position.Bottom} id="b-target" />
<Handle type="source" position={Position.Bottom} id="b-source" />

<style>
  .diagram-node {
    --node-accent: var(--solus-accent);
    --node-radius: 0.75rem;
    --node-pad: 0.625rem;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    /* Fill the xyflow node wrapper so resizing in either axis is reflected by
       the card, and so the connection handles (anchored to the wrapper's
       mid-sides) line up with the card's edges instead of drifting to its
       corners once the wrapper is resized larger than the content. */
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 12rem;
    max-width: 18rem;
    padding: var(--node-pad) 0.75rem;
    border-radius: var(--node-radius);
    border: 0.0625rem solid var(--solus-tool-border);
    background: var(--solus-container-bg);
    color: var(--solus-text-primary);
    box-shadow: 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.04), 0 0.125rem 0.5rem rgba(0, 0, 0, 0.05);
    cursor: grab;
    user-select: none;
    transition: transform var(--duration-base) var(--ease-premium), box-shadow var(--duration-base) var(--ease-premium), border-color var(--duration-base) var(--ease-premium), opacity var(--duration-modal) var(--ease-premium);
  }

  .diagram-node:hover {
    transform: translateY(-0.0625rem);
    box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.12);
    border-color: var(--solus-accent-border-medium);
  }

  .diagram-node:active { cursor: grabbing; }

  .diagram-node--selected {
    border-color: var(--solus-accent);
    box-shadow: 0 0 0 0.125rem var(--solus-accent-soft), 0 0.25rem 1rem rgba(0, 0, 0, 0.12);
  }

  /* Dimmed cards stay clickable: in focus mode a click on one moves the focus
     there (see DiagramShell.handleNodeClick) instead of hitting a dead zone. */
  .diagram-node--dimmed {
    opacity: 0.28;
    filter: saturate(0.4);
  }

  .diagram-node--clickable { cursor: pointer; }

  /* ── Shapes ──────────────────────────────────────────────────────────────
     'rectangle' is the default (the rounded card) — the base rule above, no
     modifier needed.

     'circle' and 'diamond' are decorative shapes for simple label nodes. Both
     bump the min-height so the card is roughly square — otherwise the wide card
     would read as a flat oval/rhombus — and stack the icon over a centred label. */
  .diagram-node--circle,
  .diagram-node--diamond {
    min-width: 7.5rem;
    max-width: 13rem;
    min-height: 7.5rem;
    justify-content: center;
    align-items: center;
    text-align: center;
    gap: 0.25rem;
  }
  .diagram-node--circle .diagram-node__head,
  .diagram-node--diamond .diagram-node__head {
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  .diagram-node--circle .diagram-node__title-group,
  .diagram-node--diamond .diagram-node__title-group {
    flex: 0 1 auto;
    align-items: center;
    text-align: center;
  }

  /* Circle is reachable with border-radius, so its border, box-shadow and
     selection ring all hug the outline natively. */
  .diagram-node--circle {
    border-radius: 50%;
    padding: 1rem;
  }

  /* Diamond can't use a plain border — clip-path would slice the stroke off — so
     the outline is an inline <svg> polygon behind the content. The card goes
     transparent/borderless/shadowless and the polygon supplies the fill, stroke
     and drop-shadow, with the stroke tracking hover/selection. */
  .diagram-node--diamond,
  .diagram-node--diamond:hover,
  .diagram-node--diamond.diagram-node--selected {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }
  .diagram-node--diamond {
    padding: 1.75rem 1.25rem;
  }
  /* Lift the real content above the polygon backdrop (which sits at z-index 0). */
  .diagram-node--diamond > :not(.diagram-node__shape) {
    position: relative;
    z-index: 1;
  }

  .diagram-node__shape {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    overflow: visible;
    pointer-events: none;
    filter: drop-shadow(0 0.125rem 0.5rem rgba(0, 0, 0, 0.1));
  }
  .diagram-node__shape polygon {
    fill: var(--solus-container-bg);
    stroke: var(--solus-tool-border);
    stroke-width: 1.25px;
    transition: stroke var(--duration-base) var(--ease-premium), stroke-width var(--duration-base) var(--ease-premium);
  }
  .diagram-node--diamond:hover .diagram-node__shape {
    filter: drop-shadow(0 0.25rem 0.75rem rgba(0, 0, 0, 0.16));
  }
  .diagram-node--diamond:hover .diagram-node__shape polygon {
    stroke: var(--solus-accent-border-medium);
  }
  .diagram-node--diamond.diagram-node--selected .diagram-node__shape polygon {
    stroke: var(--solus-accent);
    stroke-width: 1.75px;
  }

  /* Header */
  .diagram-node__head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .diagram-node__icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: calc(var(--node-radius) - var(--node-pad));
    background: color-mix(in srgb, var(--node-accent) 14%, transparent);
    font-size: 0.875rem;
    line-height: 1;
    color: var(--node-accent);
  }

  .diagram-node__title-group {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .diagram-node__label {
    font-size: 0.75rem;
    font-weight: 600;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    line-height: 1.3;
    word-break: break-word;
  }

  .diagram-node__subtitle {
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diagram-node__input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    border-bottom: 0.09375rem solid var(--solus-accent-border);
    outline: none;
    color: var(--solus-text-primary);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0;
  }

  /* Status dot */
  .diagram-node__status-dot {
    display: inline-block;
    flex-shrink: 0;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    box-shadow: 0 0 0 0.125rem var(--solus-container-bg);
  }

  /* Expand chevron button */
  .diagram-node__expand-btn {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    padding: 0;
    transition: background var(--duration-base) var(--ease-premium), color var(--duration-base) var(--ease-premium), transform var(--duration-base) var(--ease-premium);
  }
  .diagram-node__expand-btn:hover {
    background: color-mix(in srgb, var(--node-accent) 10%, transparent);
    color: var(--node-accent);
  }
  .diagram-node__expand-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .diagram-node__expand-icon {
    transition: transform var(--duration-base) var(--ease-premium);
  }
  .diagram-node__expand-icon--open {
    transform: rotate(180deg);
  }

  /* Drill affordance — signals the node opens a nested detail diagram. */
  .diagram-node__drill {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--node-accent) 12%, transparent);
    color: var(--node-accent);
    transition: background var(--duration-base) var(--ease-premium), transform var(--duration-base) var(--ease-premium);
  }
  .diagram-node--drillable:hover .diagram-node__drill {
    background: color-mix(in srgb, var(--node-accent) 22%, transparent);
    transform: translateX(0.0625rem);
  }

  /* Badges */
  .diagram-node__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding-left: 1.9rem;
  }

  .diagram-node__badge {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--node-accent) 10%, transparent);
    border: 0.0625rem solid color-mix(in srgb, var(--node-accent) 22%, transparent);
    color: var(--solus-text-secondary);
    font-size: 0.5625rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Legacy meta */
  .diagram-node__meta-list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding-left: 1.9rem;
  }

  .diagram-node__meta {
    font-size: 0.625rem;
    color: var(--solus-text-secondary);
    font-weight: 400;
  }

  .diagram-node__meta-key {
    color: var(--solus-text-tertiary);
    margin-right: 0.25rem;
  }

  /* Metrics (description list) */
  .diagram-node__metrics {
    margin: 0;
    padding: 0.375rem 0 0;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
  }

  .diagram-node__metric-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }

  .diagram-node__metric-key {
    font-size: 0.5625rem;
    font-weight: 500;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
  }

  .diagram-node__metric-val {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--solus-text-primary);
    font-variant-numeric: tabular-nums;
    margin: 0;
    text-align: right;
  }

  /* Tags */
  .diagram-node__tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .diagram-node__tag {
    font-size: 0.5rem;
    font-weight: 500;
    color: var(--solus-text-tertiary);
    padding: 0.0625rem 0.25rem;
    border-radius: 0.25rem;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-text-tertiary) 20%, transparent);
  }

  /* Expanded body/custom html */
  .diagram-node__body {
    font-size: 0.625rem;
    color: var(--solus-text-secondary);
    line-height: 1.55;
    margin: 0;
    padding-top: 0.25rem;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .diagram-node__custom {
    font-size: 0.625rem;
    color: var(--solus-text-secondary);
    line-height: 1.55;
    max-height: 12rem;
    overflow-y: auto;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
    padding-top: 0.25rem;
    word-break: break-word;
  }

  /* Focus ring */
  .diagram-node:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* Resize handles: small accent squares at the corners, shown only while the
     node is selected so they don't clash with the connection dots that appear
     on hover. The card's own selection ring provides the bounding feedback, so
     the resize line stays invisible. */
  :global(.node-resize-handle) {
    width: 0.4375rem !important;
    height: 0.4375rem !important;
    border-radius: 0.125rem !important;
    background: var(--solus-accent) !important;
    border: 0.09375rem solid var(--solus-container-bg) !important;
    box-shadow: 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.12) !important;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration-quick) var(--ease-premium), transform var(--duration-quick) var(--ease-premium);
  }

  :global(.svelte-flow__node.selected .node-resize-handle) {
    opacity: 1;
    pointer-events: auto;
  }

  :global(.node-resize-handle:hover) {
    transform: scale(1.25);
  }

  :global(.node-resize-line) {
    border-color: transparent !important;
  }

  @media (prefers-reduced-motion: reduce) {
    .diagram-node { transition: none; }
    .diagram-node--dimmed { transition: none; }
    .diagram-node__expand-icon { transition: none; }
  }
</style>
