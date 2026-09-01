<script lang="ts">
  import { parseDiagram, type DiagramDoc, type DiagramEdge, type DiagramNode } from '../../../shared/diagram-types'
  import { applyLayout } from '../../../shared/diagram-layout'
  import { getSettingsContext } from '../../contexts/settings.context.svelte'
  import { diagramAccent } from './diagram-colors'

  interface Props {
    content: string
  }

  type ThumbNode = {
    id: string
    label: string
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

  let { content }: Props = $props()

  const theme = getSettingsContext()
  const edgeAccent = $derived(diagramAccent(theme.isDark))
  const model = $derived(buildModel(content))
  const markerId = $derived(`diagram-thumb-arrow-${hashString(content)}`)
  const markerUrl = $derived(`url(#${markerId})`)

  function hashString(value: string): string {
    let hash = 0
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0
    }
    return hash.toString(36)
  }

  function estimateSize(node: DiagramNode): { w: number; h: number } {
    if (node.width && node.height) return { w: node.width, h: node.height }
    if (node.group) return { w: node.width ?? 320, h: node.height ?? 220 }

    const isEntity = !!node.fields?.length
    const labelWidth = node.label.length * 7 + 64
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

  function edgePath(edge: ThumbEdge): string {
    const source = edge.sourceNode!
    const target = edge.targetNode!
    const sx = centerX(source)
    const sy = centerY(source)
    const tx = centerX(target)
    const ty = centerY(target)
    const dx = tx - sx
    const midX = sx + dx / 2
    return `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`
  }

  function truncate(text: string, max = 22): string {
    const clean = text.trim()
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
  }

  function nodeAccent(node: ThumbNode): string {
    if (node.color) return node.color
    return edgeAccent
  }
</script>

<div class="diagram-thumbnail" aria-hidden="true">
  <svg class="diagram-thumbnail__map" viewBox={model.viewBox} preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
        <path d="M 0 0 L 10 5 L 0 10 z" fill={edgeAccent} opacity="0.65" />
      </marker>
    </defs>

    <rect class="diagram-thumbnail__backdrop" x="-10000" y="-10000" width="20000" height="20000" />

    {#if model.empty}
      <g class="diagram-thumbnail__empty">
        <rect x="120" y="80" width="180" height="60" rx="14" />
        <path d="M 300 110 C 336 110, 336 176, 372 176" />
        <rect x="310" y="146" width="72" height="52" rx="12" />
      </g>
    {:else}
      {#each model.groups as node (node.id)}
        <g class="diagram-thumbnail__group">
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="20" />
          <text x={node.x + 20} y={node.y + 30}>{truncate(node.label, 28)}</text>
        </g>
      {/each}

      {#each model.edges as edge (edge.id)}
        <path
          class="diagram-thumbnail__edge"
          class:diagram-thumbnail__edge--async={edge.kind === 'async' || edge.animated}
          class:diagram-thumbnail__edge--data={edge.kind === 'data'}
          d={edgePath(edge)}
          marker-end={edge.arrows === 'none' || edge.arrows === 'start' ? undefined : markerUrl}
          style:stroke={edge.color ?? undefined}
        />
      {/each}

      {#each model.nodes as node (node.id)}
        <g class="diagram-thumbnail__node">
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="14" />
          <rect class="diagram-thumbnail__node-accent" x={node.x} y={node.y} width="4" height={node.h} rx="2" style:fill={nodeAccent(node)} />
          <circle cx={node.x + 24} cy={node.y + 27} r="9" style:fill={nodeAccent(node)} />
          <text class="diagram-thumbnail__node-title" x={node.x + 42} y={node.y + 31}>{truncate(node.label)}</text>
          {#if node.fields?.length}
            <line class="diagram-thumbnail__node-rule" x1={node.x + 16} y1={node.y + 48} x2={node.x + node.w - 16} y2={node.y + 48} />
            {#each node.fields.slice(0, 3) as field, i}
              <text class="diagram-thumbnail__field" x={node.x + 18} y={node.y + 68 + i * 16}>{truncate(field.name, 18)}</text>
            {/each}
          {:else if node.badges?.length}
            <rect class="diagram-thumbnail__badge" x={node.x + 16} y={node.y + 48} width={Math.min(96, node.badges[0].length * 6 + 24)} height="18" rx="9" />
          {/if}
        </g>
      {/each}
    {/if}
  </svg>
</div>

<style>
  .diagram-thumbnail {
    width: 100%;
    height: 100%;
    min-height: 12rem;
    pointer-events: none;
    overflow: hidden;
    background:
      radial-gradient(circle at 18% 12%, color-mix(in srgb, var(--solus-accent-light) 24%, transparent), transparent 28%),
      color-mix(in srgb, var(--solus-surface-primary) 28%, var(--solus-container-bg));
  }

  .diagram-thumbnail__map {
    display: block;
    width: 100%;
    height: 100%;
  }

  .diagram-thumbnail__backdrop {
    fill: transparent;
  }

  .diagram-thumbnail__group rect {
    fill: color-mix(in srgb, var(--solus-surface-primary) 18%, transparent);
    stroke: color-mix(in srgb, var(--solus-tool-border) 76%, transparent);
    stroke-width: 2;
    stroke-dasharray: 10 8;
  }

  .diagram-thumbnail__group text {
    fill: var(--solus-text-tertiary);
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0;
  }

  .diagram-thumbnail__edge {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-accent) 72%, var(--solus-text-tertiary));
    stroke-linecap: round;
    stroke-width: 3;
    opacity: 0.54;
  }

  .diagram-thumbnail__edge--async {
    stroke-dasharray: 12 10;
  }

  .diagram-thumbnail__edge--data {
    stroke: color-mix(in srgb, #14b8a6 76%, var(--solus-text-tertiary));
  }

  .diagram-thumbnail__node rect:first-child {
    fill: color-mix(in srgb, var(--solus-container-bg) 94%, var(--solus-surface-primary));
    stroke: color-mix(in srgb, var(--solus-tool-border) 76%, transparent);
    stroke-width: 1.5;
  }

  .diagram-thumbnail__node-accent {
    opacity: 0.76;
  }

  .diagram-thumbnail__node circle {
    opacity: 0.22;
  }

  .diagram-thumbnail__node-title {
    fill: var(--solus-text-primary);
    font-size: 18px;
    font-weight: 650;
    letter-spacing: 0;
  }

  .diagram-thumbnail__node-rule {
    stroke: color-mix(in srgb, var(--solus-tool-border) 70%, transparent);
    stroke-width: 1;
  }

  .diagram-thumbnail__field {
    fill: var(--solus-text-tertiary);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0;
  }

  .diagram-thumbnail__badge {
    fill: color-mix(in srgb, var(--solus-accent-light) 46%, transparent);
  }

  .diagram-thumbnail__empty rect {
    fill: color-mix(in srgb, var(--solus-container-bg) 90%, var(--solus-surface-primary));
    stroke: color-mix(in srgb, var(--solus-tool-border) 76%, transparent);
  }

  .diagram-thumbnail__empty path {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-accent) 62%, var(--solus-text-tertiary));
    stroke-linecap: round;
    stroke-width: 3;
  }
</style>
