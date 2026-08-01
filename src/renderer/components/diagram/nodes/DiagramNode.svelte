<script lang="ts">
  import { Handle, Position, NodeResizer } from '@xyflow/svelte'
  import Icon from '@iconify/svelte'
  import type { DiagramNode, DiagramAction } from '../../../../shared/diagram-types'
  import { sanitizeNodeHtml, isSafeUrl } from '../../../../shared/diagram-sanitize'
  import { resolveIcon } from '../diagram-icons'
  import { EditableLabel } from '../editable-label.svelte'
  import { ensureIconCollections } from '../iconify'
  import { isDecorativeNodeShape, isSimpleShapeNode } from '../diagram-node-shapes'
  import { cardFields } from '../lib/node-card'
  import type { PinSummary } from '../lib/comment-threads'
  import CommentPin from '../CommentPin.svelte'

  interface NodeData extends DiagramNode {
    expanded?: boolean
    dimmed?: boolean
    resizable?: boolean
    /** The one pin every thread on this node collapses into (transient, from
        the sidecar). Absent = no visible threads. */
    commentPin?: PinSummary
    onLabelChange?: (id: string, label: string) => void
    onAction?: (nodeId: string, action: DiagramAction) => void
    onResize?: (id: string, width: number, height: number) => void
    onContextMenu?: (id: string, type: 'node' | 'edge', x: number, y: number) => void
    // Open the editor side menu for this node. Driven from the node's own click
    // handler so it fires for any click on the card — including over inner
    // controls that stopPropagation (which would otherwise block xyflow's
    // onnodeclick). Absent in read-only contexts (e.g. thumbnails).
    onSelect?: (id: string) => void
    /** Open this node's thread card on the canvas. */
    onOpenThread?: (id: string) => void
  }

  interface Props {
    data: NodeData
    selected?: boolean
  }

  let { data, selected = false }: Props = $props()

  // Presence of `fields` (on a non-group node) makes this a data-model entity:
  // it renders an always-visible field table and defaults to a table glyph.
  const isEntity = $derived(!!data.fields?.length && !data.group)
  // The card caps its field list; the inspector's Data tab is the full view.
  const fields = $derived(cardFields(data.fields))
  const KEY_TITLE = { pk: 'Primary key', fk: 'Foreign key', unique: 'Unique' } as const

  const resolved = $derived(resolveIcon(data.icon, isEntity ? 'table' : 'service'))
  const iconifyName = $derived(resolved.iconify)
  $effect(() => {
    if (iconifyName) void ensureIconCollections()
  })
  const iconSvg = $derived(resolved.svg)
  const iconEmoji = $derived(resolved.emoji)

  // Card outline. 'rectangle' is the default (the rounded card); circle/diamond
  // are decorative modifiers that only apply to a simple label node.
  const shape = $derived(
    isDecorativeNodeShape(data.shape) && !isSimpleShapeNode(data) ? 'rectangle' : (data.shape ?? 'rectangle')
  )

  // `drilldown` is excluded alongside `openFile`: the drill badge is the only
  // way into a nested graph, so a node carrying a subgraph stays a plain select
  // target. Authored docs pair `detail` with a drilldown click action, which
  // would otherwise swallow every click on the card body.
  const primaryAction = $derived(
    data.actions?.find(
      (a) => a.on === 'click' && a.action.do !== 'openFile' && a.action.do !== 'drilldown'
    )?.action ?? null
  )
  // A node carrying a `detail` sub-diagram gets a drill badge showing how many
  // nodes are nested inside it. The badge — not the card — is what drills.
  const childCount = $derived(data.detail?.nodes?.length ?? 0)
  const drillable = $derived(childCount > 0)
  const hasExpandable = $derived(!!(data.body || data.html || data.metrics))
  // Stacked-paper shadow: this card stands for more than itself, either a nested
  // graph or a record set.
  const hasDepth = $derived(drillable || isEntity)

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
      if (primaryAction) dispatch(primaryAction)
    }
  }

  // The drill badge stops propagation so it drills instead of selecting — the
  // card body stays a plain select target even on a node with a nested graph.
  function handleDrillClick(e: MouseEvent) {
    e.stopPropagation()
    dispatch({ do: 'drilldown' })
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
    minWidth={200}
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

<!-- Outside the card, not inside it: an entity card clips its field list to its
     own radius, and the pin is meant to overlap the corner anyway. -->
{#if data.commentPin}
  <CommentPin
    pin={data.commentPin}
    anchorLabel={data.label}
    onOpen={() => data.onOpenThread?.(data.id)}
  />
{/if}

<div
  class="diagram-node diagram-node--{shape}"
  class:diagram-node--selected={selected}
  class:diagram-node--dimmed={data.dimmed}
  class:diagram-node--clickable={!!primaryAction && !editor.editing}
  class:diagram-node--entity={isEntity}
  class:diagram-node--depth={hasDepth}
  class:diagram-node--tinted={!!data.color}
  class:diagram-node--expanded={data.expanded}
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

  <!-- Kind row: glyph + kind word, then the contextual actions. The label is a
       separate line below, so it always gets the card's full width. -->
  <div class="diagram-node__kind">
    <span class="diagram-node__icon" aria-hidden="true">
      {#if iconifyName}
        <!-- Brand logos are pictorial, not stroke glyphs — they need the extra
             two pixels to stay legible at card scale. -->
        <Icon icon={iconifyName} width="14" height="14" />
      {:else if iconSvg}
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {@html iconSvg}
        </svg>
      {:else}
        {iconEmoji}
      {/if}
    </span>

    {#if data.subtitle}
      <span class="diagram-node__subtitle">{data.subtitle}</span>
    {/if}

    <span class="diagram-node__kind-spacer"></span>

    {#if drillable}
      <button
        type="button"
        class="diagram-node__drill"
        onclick={handleDrillClick}
        title="Open detail diagram ({childCount} {childCount === 1 ? 'node' : 'nodes'})"
        aria-label="Open detail diagram, {childCount} {childCount === 1 ? 'node' : 'nodes'}"
      >
        <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <rect x="2" y="5" width="9" height="9" rx="2" />
          <path d="M5 5V3.5A1.5 1.5 0 0 1 6.5 2h6A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H11" />
        </svg>
        {childCount}
      </button>
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

  <!-- Label — always the last text line before the fields. -->
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

  <!-- Meta chips (always visible), capped at two so they stay a footnote. -->
  {#if data.badges?.length}
    <div class="diagram-node__badges">
      {#each data.badges.slice(0, 2) as badge}
        <span class="diagram-node__badge">{badge}</span>
      {/each}
    </div>
  {/if}

  <!-- Entity field table. Bleeds to the card edge on a muted wash so it reads as
       a distinct register from the card's own copy. -->
  {#if isEntity}
    <div class="diagram-node__fields">
      {#each fields.shown as field}
        <div class="diagram-node__field">
          {#if field.key === 'pk'}
            <svg class="diagram-node__field-key" viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="var(--solus-accent)" stroke-width="1.7" aria-hidden="true">
              <title>{KEY_TITLE.pk}</title>
              <circle cx="5.5" cy="5.5" r="3" />
              <path d="M8 8l5 5M11 11l-1.5 1.5" />
            </svg>
          {:else if field.key}
            <span class="diagram-node__field-key diagram-node__field-key--letters" title={KEY_TITLE[field.key]}>
              {field.key === 'fk' ? 'FK' : 'UQ'}
            </span>
          {:else}
            <span class="diagram-node__field-key" aria-hidden="true"></span>
          {/if}
          <span class="diagram-node__field-name" class:diagram-node__field-name--nullable={field.nullable}>{field.name}</span>
          {#if field.ref}
            <span class="diagram-node__field-type" title="References {field.ref}">→ {field.ref}</span>
          {/if}
          {#if field.type}
            <span class="diagram-node__field-type" title={field.type}>{field.type}</span>
          {/if}
        </div>
      {/each}
      {#if fields.overflow > 0}
        <div class="diagram-node__field-more">+{fields.overflow} more</div>
      {/if}
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
    --node-radius: 0.625rem;
    /* The card's three shadow roles are separate layers so they compose instead
       of overwriting each other: a selection ring, the stacked-paper depth mark,
       and the ambient lift. Transparent placeholders keep the list valid when a
       role is off. */
    --node-ring: 0 0 #0000;
    --node-depth: 0 0 #0000;
    --node-ambient: 0 0.0625rem 0.125rem rgba(60, 40, 25, 0.05);
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.09375rem;
    /* Fill the xyflow node wrapper so resizing in either axis is reflected by
       the card, and so the connection handles (anchored to the wrapper's
       mid-sides) line up with the card's edges instead of drifting to its
       corners once the wrapper is resized larger than the content. */
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 12.5rem;
    max-width: 18rem;
    padding: 0.5625rem 0.6875rem 0.625rem;
    border-radius: var(--node-radius);
    border: 0.0625rem solid var(--solus-tool-border);
    background: var(--solus-container-bg);
    color: var(--solus-text-primary);
    box-shadow: var(--node-ring), var(--node-depth), var(--node-ambient);
    cursor: grab;
    user-select: none;
    transition: transform var(--duration-base) var(--ease-premium), box-shadow var(--duration-base) var(--ease-premium), border-color var(--duration-base) var(--ease-premium), opacity var(--duration-modal) var(--ease-premium);
  }

  .diagram-node:hover {
    transform: translateY(-0.0625rem);
    --node-ambient: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.06);
    border-color: color-mix(in srgb, var(--solus-text-tertiary) 32%, transparent);
  }

  .diagram-node:active { cursor: grabbing; }

  /* Stacked paper — this card stands for a nested graph or a record set. */
  .diagram-node--depth {
    --node-depth:
      0.25rem 0.25rem 0 -0.0625rem var(--solus-container-bg),
      0.3125rem 0.3125rem 0 -0.0625rem var(--solus-tool-border);
  }

  /* The field wash bleeds to the card edge, so it needs the radius to clip it. */
  .diagram-node--entity { overflow: hidden; }

  /* Selection ring: a gap, a 1.5px accent stroke, then a soft halo. Drawn as
     spreads rather than a pseudo-element so it survives the entity card's
     overflow clip, grows the radius 10 → 14 on its own, and can never take a
     pointer event. */
  .diagram-node--selected {
    --node-ring:
      0 0 0 0.15625rem var(--solus-container-bg),
      0 0 0 0.25rem var(--solus-accent),
      0 0 0 0.5rem color-mix(in srgb, var(--solus-accent) 12%, transparent);
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
  .diagram-node--circle .diagram-node__kind,
  .diagram-node--diamond .diagram-node__kind {
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  /* The spacer only earns its keep in the horizontal kind row. */
  .diagram-node--circle .diagram-node__kind-spacer,
  .diagram-node--diamond .diagram-node__kind-spacer {
    display: none;
  }
  .diagram-node--circle .diagram-node__label,
  .diagram-node--diamond .diagram-node__label {
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

  /* Kind row — what the node IS, in one line of small caps. */
  .diagram-node__kind {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 0.875rem;
  }

  .diagram-node__kind-spacer {
    flex: 1;
    min-width: 0;
  }

  .diagram-node__icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 0.875rem;
    height: 0.875rem;
    font-size: 0.75rem;
    line-height: 1;
    /* Neutral by default: a canvas of tinted glyphs is noise. A node the user
       deliberately coloured keeps its tint here, so colour-coding still reads. */
    color: var(--diagram-glyph, var(--solus-text-tertiary));
  }

  .diagram-node--tinted .diagram-node__icon {
    color: var(--node-accent);
  }

  .diagram-node__label {
    font-size: 0.84375rem;
    font-weight: 650;
    letter-spacing: -0.014em;
    line-height: 1.15;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    word-break: break-word;
  }

  .diagram-node__subtitle {
    font-size: 0.53125rem;
    color: var(--solus-text-tertiary);
    font-weight: 650;
    line-height: 1.2;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diagram-node__input {
    min-width: 0;
    background: transparent;
    border: none;
    border-bottom: 0.09375rem solid var(--solus-accent-border);
    outline: none;
    color: var(--solus-text-primary);
    font-size: 0.84375rem;
    font-weight: 650;
    letter-spacing: -0.014em;
    padding: 0;
  }

  /* Contextual header actions stay out of the resting silhouette. Keyboard
     focus reveals them before the control itself receives focus. */
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
    opacity: 0;
    pointer-events: none;
    transform: translateX(0.1875rem);
    transition:
      opacity var(--duration-quick) var(--ease-premium),
      background var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium),
      transform var(--duration-base) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }
  .diagram-node__expand-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .diagram-node__expand-btn:active { scale: 0.96; }
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

  /* Drill badge — the node's child count, and the only thing on the card that
     enters the nested graph. Always visible: it carries information, so unlike
     the hover-revealed actions it belongs in the resting silhouette. */
  .diagram-node__drill {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    flex-shrink: 0;
    padding: 0.0625rem 0.3125rem;
    border: none;
    border-radius: 0.25rem;
    font-family: var(--solus-code-font-family);
    font-size: 0.59375rem;
    font-variant-numeric: tabular-nums;
    color: var(--solus-accent);
    background: color-mix(in srgb, var(--solus-accent) 10%, transparent);
    cursor: pointer;
    transition: background var(--duration-base) var(--ease-premium);
  }
  .diagram-node__drill:hover {
    background: color-mix(in srgb, var(--solus-accent) 20%, transparent);
  }
  .diagram-node__drill:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .diagram-node:hover .diagram-node__expand-btn,
  .diagram-node:focus-within .diagram-node__expand-btn,
  .diagram-node--selected .diagram-node__expand-btn,
  .diagram-node--expanded .diagram-node__expand-btn {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
  }

  /* Meta chips */
  .diagram-node__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.125rem;
  }

  .diagram-node__badge {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.3125rem;
    border-radius: 0.25rem;
    background: transparent;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-text-tertiary) 20%, transparent);
    color: var(--solus-text-secondary);
    font-size: 0.625rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Entity field table. Negative margins pull it out to the card's edges — the
     card's own padding is 9/11/10, so these mirror it exactly. */
  .diagram-node__fields {
    display: flex;
    flex-direction: column;
    margin: 0.1875rem -0.6875rem -0.625rem;
    border-top: 0.0625rem solid var(--solus-tool-border);
    background: color-mix(in srgb, var(--solus-surface-hover) 55%, transparent);
  }

  .diagram-node__field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.21875rem 0.6875rem;
  }

  .diagram-node__field-key {
    flex: none;
    width: 0.5625rem;
    height: 0.5625rem;
  }

  .diagram-node__field-key--letters {
    font-size: 0.46875rem;
    font-weight: 700;
    line-height: 0.5625rem;
    letter-spacing: 0.02em;
    color: var(--solus-text-tertiary);
  }

  .diagram-node__field-name {
    flex: 1;
    min-width: 0;
    font-family: var(--solus-code-font-family);
    font-size: 0.625rem;
    letter-spacing: -0.01em;
    color: var(--solus-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagram-node__field-name--nullable {
    color: var(--solus-text-secondary);
    font-style: italic;
  }

  .diagram-node__field-type {
    flex: 0 1 auto;
    min-width: 0;
    font-family: var(--solus-code-font-family);
    font-size: 0.59375rem;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagram-node__field-more {
    font-family: var(--solus-code-font-family);
    font-size: 0.59375rem;
    color: var(--solus-text-tertiary);
    opacity: 0.8;
    padding: 0.1875rem 0.6875rem 0.3125rem 1.6875rem;
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
    .diagram-node__drill,
    .diagram-node__expand-btn,
    .diagram-node__expand-icon { transition: none; }
  }
</style>
