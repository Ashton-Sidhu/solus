<script lang="ts">
  import { parseDiagram, type DiagramDoc, type DiagramEdge, type DiagramNode } from '../../../shared/diagram-types'
  import { applyLayout } from '../../../shared/diagram-layout'
  import { getSettingsContext } from '../../contexts'
  import { diagramAccent } from './diagram-colors'
  import { effectiveEdgeDash } from './lib/flow-builders'

  interface Props {
    content: string
  }

  type ThumbNode = {
    id: string
    label: string
    subtitle?: string
    x: number
    y: number
    w: number
    h: number
    group: boolean
    color?: string
    fields?: DiagramNode['fields']
    badges?: string[]
  }

  type ThumbEdge = DiagramEdge & {
    sourceNode?: ThumbNode
    targetNode?: ThumbNode
  }

  type ThumbModel = {
    nodes: ThumbNode[]
    groups: ThumbNode[]
    edges: ThumbEdge[]
    viewBox: string
    empty: boolean
  }

  interface DiagramSize {
    w: number
    h: number
  }

  interface EdgeAnchors {
    sx: number
    sy: number
    tx: number
    ty: number
    horizontal: boolean
  }

  // Card geometry in diagram units — the miniature mirrors the canvas card:
  // an optional small-caps kind line, then the label, then fields or chips.
  const PAD_X = 15
  const TITLE_SIZE = 13
  const SUBTITLE_SIZE = 9
  const FIELD_SIZE = 10

  let { content }: Props = $props()

  const theme = getSettingsContext()
  const edgeAccent = $derived(diagramAccent(theme.isDark))
  const model = $derived(buildModel(content))
  const idSeed = $derived(hashString(content))
  const markerId = $derived(`diagram-thumb-arrow-${idSeed}`)
  const shadowId = $derived(`diagram-thumb-shadow-${idSeed}`)
  const markerUrl = $derived(`url(#${markerId})`)
  const shadowUrl = $derived(`url(#${shadowId})`)

  function hashString(value: string): string {
    let hash = 0
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0
    }
    return hash.toString(36)
  }

  function estimateSize(node: DiagramNode): DiagramSize {
    if (node.width && node.height) return { w: node.width, h: node.height }
    if (node.group) return { w: node.width ?? 320, h: node.height ?? 220 }

    const isEntity = !!node.fields?.length
    const labelWidth = node.label.length * 7 + 44
    const fieldWidth = isEntity
      ? Math.max(...node.fields!.map((f) => f.name.length * 6 + (f.type?.length ?? 0) * 5 + 56), 0)
      : 0
    const w = Math.max(180, Math.min(isEntity ? 320 : 260, Math.max(labelWidth, fieldWidth)))
    const h =
      54 +
      (node.subtitle ? 16 : 0) +
      (node.badges?.length ? 20 : 0) +
      (isEntity ? Math.min(node.fields!.length, 4) * 16 + 14 : 0)
    return { w, h }
  }

  function absolutePosition(node: DiagramNode, byId: Map<string, DiagramNode>, cache: Map<string, { x: number; y: number }>): { x: number; y: number } {
    const cached = cache.get(node.id)
    if (cached) return cached

    const own = node.position ?? { x: 0, y: 0 }
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    const out = parent
      ? (() => {
          const p = absolutePosition(parent, byId, cache)
          return { x: p.x + own.x, y: p.y + own.y }
        })()
      : own
    cache.set(node.id, out)
    return out
  }

  function buildModel(json: string): ThumbModel {
    try {
      const doc = applyLayout(parseDiagram(json))
      return modelFromDoc(doc)
    } catch {
      return emptyModel()
    }
  }

  function modelFromDoc(doc: DiagramDoc): ThumbModel {
    if (!doc.nodes.length) return emptyModel()

    const byId = new Map(doc.nodes.map((node) => [node.id, node]))
    const positionCache = new Map<string, { x: number; y: number }>()
    const thumbNodes = doc.nodes.map((node) => {
      const size = estimateSize(node)
      const position = absolutePosition(node, byId, positionCache)
      return {
        id: node.id,
        label: node.label,
        subtitle: node.subtitle,
        x: position.x,
        y: position.y,
        w: size.w,
        h: size.h,
        group: !!node.group,
        color: node.color,
        fields: node.fields,
        badges: node.badges,
      } satisfies ThumbNode
    })

    const nodeById = new Map(thumbNodes.map((node) => [node.id, node]))
    const edges = doc.edges
      .map((edge) => ({
        ...edge,
        sourceNode: nodeById.get(edge.source),
        targetNode: nodeById.get(edge.target),
      }))
      .filter((edge) => edge.sourceNode && edge.targetNode)

    const boundsNodes = thumbNodes.length
      ? thumbNodes
      : [{ x: 0, y: 0, w: 420, h: 220 }]
    const minX = Math.min(...boundsNodes.map((node) => node.x))
    const minY = Math.min(...boundsNodes.map((node) => node.y))
    const maxX = Math.max(...boundsNodes.map((node) => node.x + node.w))
    const maxY = Math.max(...boundsNodes.map((node) => node.y + node.h))
    const pad = Math.max(48, Math.min(96, Math.max(maxX - minX, maxY - minY) * 0.08))

    return {
      nodes: thumbNodes.filter((node) => !node.group),
      groups: thumbNodes.filter((node) => node.group),
      edges,
      viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
      empty: false,
    }
  }

  function emptyModel(): ThumbModel {
    return { nodes: [], groups: [], edges: [], viewBox: '0 0 420 220', empty: true }
  }

  function centerX(node: ThumbNode): number {
    return node.x + node.w / 2
  }

  function centerY(node: ThumbNode): number {
    return node.y + node.h / 2
  }

  // Anchor each end on the card edge that faces the other card, so a line never
  // disappears under a node the way a centre-to-centre path does.
  function edgeAnchors(edge: ThumbEdge): EdgeAnchors {
    const source = edge.sourceNode!
    const target = edge.targetNode!
    const dx = centerX(target) - centerX(source)
    const dy = centerY(target) - centerY(source)
    const horizontal = Math.abs(dx) >= Math.abs(dy)

    if (horizontal) {
      const forward = dx >= 0
      return {
        sx: forward ? source.x + source.w : source.x,
        sy: centerY(source),
        tx: forward ? target.x : target.x + target.w,
        ty: centerY(target),
        horizontal,
      }
    }
    const downward = dy >= 0
    return {
      sx: centerX(source),
      sy: downward ? source.y + source.h : source.y,
      tx: centerX(target),
      ty: downward ? target.y : target.y + target.h,
      horizontal,
    }
  }

  function edgePath(edge: ThumbEdge): string {
    const { sx, sy, tx, ty, horizontal } = edgeAnchors(edge)
    const bend = Math.max(24, Math.min(120, Math.abs(horizontal ? tx - sx : ty - sy) * 0.42))
    return horizontal
      ? `M ${sx} ${sy} C ${sx + Math.sign(tx - sx || 1) * bend} ${sy}, ${tx - Math.sign(tx - sx || 1) * bend} ${ty}, ${tx} ${ty}`
      : `M ${sx} ${sy} C ${sx} ${sy + Math.sign(ty - sy || 1) * bend}, ${tx} ${ty - Math.sign(ty - sy || 1) * bend}, ${tx} ${ty}`
  }

  // Truncate to what the card can actually hold rather than a fixed count, so a
  // wide card is not clipped mid-word and a narrow one never overflows.
  function fit(text: string, width: number, size: number): string {
    const clean = text.trim()
    const max = Math.max(4, Math.floor((width - PAD_X * 2) / (size * 0.55)))
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
  }

  function hasBody(node: ThumbNode): boolean {
    return !!node.fields?.length || !!node.badges?.length
  }

  // With no body the label sits optically centred; with one it holds the top of
  // the card, matching the canvas card's stacked layout.
  function titleBaseline(node: ThumbNode): number {
    if (hasBody(node)) return node.y + (node.subtitle ? 42 : 31)
    return node.y + node.h / 2 + (node.subtitle ? 11 : 4.5)
  }

  function nodeAccent(node: ThumbNode): string {
    return node.color ?? edgeAccent
  }

  function badgeWidth(text: string): number {
    return Math.min(104, text.trim().length * 5.4 + 20)
  }
</script>

<div class="diagram-thumbnail" aria-hidden="true">
  <svg class="diagram-thumbnail__map" viewBox={model.viewBox} preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
        <path d="M 1 1 L 6 3.5 L 1 6" fill="none" stroke={edgeAccent} stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.75" />
      </marker>
      <filter id={shadowId} x="-30%" y="-30%" width="160%" height="180%">
        <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" flood-color="rgb(60 40 25)" flood-opacity="0.10" />
      </filter>
    </defs>

    {#if model.empty}
      <g class="diagram-thumbnail__empty">
        <rect x="118" y="76" width="168" height="56" rx="12" filter={shadowUrl} />
        <path d="M 286 104 C 318 104, 318 172, 350 172" />
        <rect x="350" y="146" width="120" height="52" rx="12" filter={shadowUrl} />
      </g>
    {:else}
      {#each model.groups as node (node.id)}
        <g class="diagram-thumbnail__group">
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="18" />
          <text x={node.x + 18} y={node.y + 26}>{fit(node.label, node.w, 11)}</text>
        </g>
      {/each}

      {#each model.edges as edge (edge.id)}
        {@const dash = effectiveEdgeDash(edge.kind, edge.dash)}
        <path
          class="diagram-thumbnail__edge"
          class:diagram-thumbnail__edge--async={dash === 'dashed' || edge.animated}
          class:diagram-thumbnail__edge--dotted={dash === 'dotted'}
          class:diagram-thumbnail__edge--data={edge.kind === 'data'}
          d={edgePath(edge)}
          marker-end={edge.arrows === 'none' || edge.arrows === 'start' ? undefined : markerUrl}
          style:stroke={edge.color ?? undefined}
        />
      {/each}

      {#each model.nodes as node (node.id)}
        {@const baseline = titleBaseline(node)}
        <g class="diagram-thumbnail__node" class:diagram-thumbnail__node--tinted={!!node.color} style:--thumb-accent={nodeAccent(node)}>
          <rect
            class="diagram-thumbnail__card"
            x={node.x}
            y={node.y}
            width={node.w}
            height={node.h}
            rx="11"
            filter={shadowUrl}
          />

          {#if node.subtitle}
            <text class="diagram-thumbnail__subtitle" x={node.x + PAD_X} y={baseline - 15} font-size={SUBTITLE_SIZE}>
              {fit(node.subtitle.toUpperCase(), node.w, SUBTITLE_SIZE)}
            </text>
          {/if}

          <text class="diagram-thumbnail__title" x={node.x + PAD_X} y={baseline} font-size={TITLE_SIZE}>
            {fit(node.label, node.w, TITLE_SIZE)}
          </text>

          {#if node.fields?.length}
            <line class="diagram-thumbnail__rule" x1={node.x} y1={baseline + 12} x2={node.x + node.w} y2={baseline + 12} />
            {#each node.fields.slice(0, 4) as field, i}
              <text class="diagram-thumbnail__field" x={node.x + PAD_X} y={baseline + 29 + i * 16} font-size={FIELD_SIZE}>
                {fit(field.name, node.w * 0.62, FIELD_SIZE)}
              </text>
              {#if field.type}
                <text class="diagram-thumbnail__field-type" x={node.x + node.w - PAD_X} y={baseline + 29 + i * 16} font-size={FIELD_SIZE} text-anchor="end">
                  {fit(field.type, node.w * 0.38, FIELD_SIZE)}
                </text>
              {/if}
            {/each}
          {:else if node.badges?.length}
            {#each node.badges.slice(0, 2) as badge, i}
              {@const offset = i === 0 ? 0 : badgeWidth(node.badges[0]) + 6}
              <g class="diagram-thumbnail__badge">
                <rect x={node.x + PAD_X + offset} y={baseline + 8} width={badgeWidth(badge)} height="16" rx="8" />
                <text x={node.x + PAD_X + offset + badgeWidth(badge) / 2} y={baseline + 19} font-size="9" text-anchor="middle">
                  {fit(badge, badgeWidth(badge) + PAD_X * 2 - 12, 9)}
                </text>
              </g>
            {/each}
          {/if}
        </g>
      {/each}
    {/if}
  </svg>
</div>

<style>
  /* The dot grid is painted in screen space, not the SVG's user space, so it
     keeps a constant density however far the diagram is scaled down to fit —
     and it reads as the same canvas the diagram opens onto. */
  .diagram-thumbnail {
    --thumb-dot: rgba(42, 38, 24, 0.1);
    width: 100%;
    height: 100%;
    min-height: 12rem;
    pointer-events: none;
    overflow: hidden;
    background-color: var(--solus-container-bg);
    background-image: radial-gradient(circle, var(--thumb-dot) 1px, transparent 1px);
    background-size: 1.375rem 1.375rem;
    background-position: center;
  }

  :global(.dark) .diagram-thumbnail {
    --thumb-dot: rgba(255, 255, 255, 0.08);
  }

  .diagram-thumbnail__map {
    display: block;
    width: 100%;
    height: 100%;
  }

  .diagram-thumbnail__group rect {
    fill: color-mix(in srgb, var(--solus-surface-primary) 22%, transparent);
    stroke: color-mix(in srgb, var(--solus-tool-border) 70%, transparent);
    stroke-width: 1.25;
    stroke-dasharray: 6 6;
  }

  .diagram-thumbnail__group text {
    fill: var(--solus-text-tertiary);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .diagram-thumbnail__edge {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-accent) 55%, var(--solus-text-tertiary));
    stroke-linecap: round;
    stroke-width: 1.75;
    opacity: 0.5;
  }

  .diagram-thumbnail__edge--async {
    stroke-dasharray: 7 6;
  }

  .diagram-thumbnail__edge--dotted {
    stroke-dasharray: 0.1 6;
  }

  .diagram-thumbnail__edge--data {
    stroke: color-mix(in srgb, #14b8a6 70%, var(--solus-text-tertiary));
  }

  .diagram-thumbnail__card {
    fill: var(--solus-container-bg);
    stroke: var(--solus-tool-border);
    stroke-width: 1;
  }

  /* A deliberately coloured node tints its edge and its kind line — the same
     places the canvas card carries colour — instead of wearing a marker. */
  .diagram-thumbnail__node--tinted .diagram-thumbnail__card {
    stroke: color-mix(in srgb, var(--thumb-accent) 42%, var(--solus-tool-border));
  }

  .diagram-thumbnail__node--tinted .diagram-thumbnail__subtitle {
    fill: var(--thumb-accent);
    opacity: 0.85;
  }

  .diagram-thumbnail__title {
    fill: var(--solus-text-primary);
    font-weight: 500;
    letter-spacing: -0.005em;
  }

  .diagram-thumbnail__subtitle {
    fill: var(--solus-text-tertiary);
    font-weight: 600;
    letter-spacing: 0.09em;
  }

  .diagram-thumbnail__rule {
    stroke: color-mix(in srgb, var(--solus-tool-border) 80%, transparent);
    stroke-width: 1;
  }

  .diagram-thumbnail__field {
    fill: var(--solus-text-secondary);
    font-weight: 450;
  }

  .diagram-thumbnail__field-type {
    fill: var(--solus-text-tertiary);
    font-weight: 450;
  }

  .diagram-thumbnail__badge rect {
    fill: color-mix(in srgb, var(--solus-surface-primary) 60%, transparent);
    stroke: color-mix(in srgb, var(--solus-tool-border) 60%, transparent);
    stroke-width: 1;
  }

  .diagram-thumbnail__badge text {
    fill: var(--solus-text-tertiary);
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .diagram-thumbnail__empty rect {
    fill: var(--solus-container-bg);
    stroke: var(--solus-tool-border);
    stroke-width: 1;
  }

  .diagram-thumbnail__empty path {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-accent) 45%, var(--solus-text-tertiary));
    stroke-linecap: round;
    stroke-width: 1.75;
    opacity: 0.5;
  }
</style>
