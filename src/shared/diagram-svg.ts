import { applyLayout } from './diagram-layout'
import type { DiagramDoc, DiagramNode } from './diagram-types'

interface SvgNode {
  node: DiagramNode
  x: number
  y: number
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

interface NodeSize {
  width: number
  height: number
}

const DEFAULT_ACCENT = '#b85c3d'

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function safeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  const color = value.trim()
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color
  if (/^(?:rgb|hsl)a?\([0-9.,%\s+-]+\)$/i.test(color)) return color
  if (/^[a-z]{3,20}$/i.test(color)) return color
  return fallback
}

function estimateNode(node: DiagramNode): NodeSize {
  if (node.width && node.height) return { width: node.width, height: node.height }
  if (node.group) return { width: node.width ?? 320, height: node.height ?? 220 }
  const fieldRows = Math.min(node.fields?.length ?? 0, 6)
  const width = Math.max(180, Math.min(340, node.label.length * 7 + 76))
  const height = 58 + (node.subtitle ? 18 : 0) + (fieldRows ? fieldRows * 18 + 18 : 0)
  return { width, height }
}

function absolutePosition(
  node: DiagramNode,
  byId: Map<string, DiagramNode>,
  cache: Map<string, Point>,
): Point {
  const cached = cache.get(node.id)
  if (cached) return cached
  const own = node.position ?? { x: 0, y: 0 }
  const parent = node.parentId ? byId.get(node.parentId) : undefined
  const position = parent
    ? (() => {
        const parentPosition = absolutePosition(parent, byId, cache)
        return { x: parentPosition.x + own.x, y: parentPosition.y + own.y }
      })()
    : own
  cache.set(node.id, position)
  return position
}

function text(value: string, x: number, y: number, className: string): string {
  return `<text x="${x}" y="${y}" class="${className}">${escapeXml(value)}</text>`
}

export function renderDiagramSvg(input: DiagramDoc): string {
  const doc = applyLayout(input)
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  const positionCache = new Map<string, Point>()
  const nodes: SvgNode[] = doc.nodes.map((node) => {
    const size = estimateNode(node)
    const position = absolutePosition(node, byId, positionCache)
    return { node, x: position.x, y: position.y, ...size }
  })

  if (nodes.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320" role="img" aria-label="Empty diagram"><rect width="640" height="320" rx="20" fill="#ffffff"/><rect x="220" y="120" width="200" height="80" rx="16" fill="#f7f5f2" stroke="#d8d3cc"/><text x="320" y="165" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="15" fill="#77716a">Empty diagram</text></svg>'
  }

  const minX = Math.min(...nodes.map((entry) => entry.x))
  const minY = Math.min(...nodes.map((entry) => entry.y))
  const maxX = Math.max(...nodes.map((entry) => entry.x + entry.width))
  const maxY = Math.max(...nodes.map((entry) => entry.y + entry.height))
  const padding = 72
  const viewWidth = Math.max(320, maxX - minX + padding * 2)
  const viewHeight = Math.max(220, maxY - minY + padding * 2)
  const renderedWidth = Math.min(1600, Math.round(viewWidth))
  const renderedHeight = Math.max(220, Math.round(renderedWidth * (viewHeight / viewWidth)))
  const nodeById = new Map(nodes.map((entry) => [entry.node.id, entry]))

  const groups = nodes
    .filter((entry) => entry.node.group)
    .map((entry) => {
      const accent = safeColor(entry.node.color, DEFAULT_ACCENT)
      return `<g><rect x="${entry.x}" y="${entry.y}" width="${entry.width}" height="${entry.height}" rx="22" fill="#faf8f5" stroke="#d8d3cc" stroke-width="2" stroke-dasharray="7 5"/><rect x="${entry.x}" y="${entry.y}" width="6" height="${entry.height}" rx="3" fill="${accent}"/>${text(entry.node.label, entry.x + 22, entry.y + 34, 'group-title')}</g>`
    })
    .join('')

  const edges = doc.edges
    .map((edge) => {
      const source = nodeById.get(edge.source)
      const target = nodeById.get(edge.target)
      if (!source || !target) return ''
      const sx = source.x + source.width / 2
      const sy = source.y + source.height / 2
      const tx = target.x + target.width / 2
      const ty = target.y + target.height / 2
      const middleX = sx + (tx - sx) / 2
      const color = safeColor(edge.color, '#8d8780')
      const dash = edge.dash === 'dotted' ? '2 7' : edge.dash === 'dashed' || edge.kind === 'async' ? '9 7' : undefined
      const marker = edge.arrows === 'none' || edge.arrows === 'start' ? '' : ' marker-end="url(#arrow)"'
      const label = edge.label
        ? `<rect x="${middleX - edge.label.length * 3.5 - 8}" y="${(sy + ty) / 2 - 13}" width="${edge.label.length * 7 + 16}" height="22" rx="11" fill="#ffffff" stroke="#e4dfd8"/>${text(edge.label, middleX, (sy + ty) / 2 + 3, 'edge-label')}`
        : ''
      return `<g><path d="M ${sx} ${sy} C ${middleX} ${sy}, ${middleX} ${ty}, ${tx} ${ty}" fill="none" stroke="${color}" stroke-width="${edge.width ?? (edge.kind === 'data' ? 3 : 2)}"${dash ? ` stroke-dasharray="${dash}"` : ''}${marker}/>${label}</g>`
    })
    .join('')

  const cards = nodes
    .filter((entry) => !entry.node.group)
    .map((entry) => {
      const accent = safeColor(entry.node.color, DEFAULT_ACCENT)
      const titleY = entry.y + 34
      const subtitle = entry.node.subtitle ? text(entry.node.subtitle, entry.x + 24, entry.y + 55, 'subtitle') : ''
      const fieldsStart = entry.y + (entry.node.subtitle ? 79 : 61)
      const fields = (entry.node.fields ?? []).slice(0, 6).map((field, index) => {
        const y = fieldsStart + index * 18
        const type = field.type ? `<text x="${entry.x + entry.width - 18}" y="${y}" text-anchor="end" class="field-type">${escapeXml(field.type)}</text>` : ''
        return `${text(field.name, entry.x + 24, y, 'field-name')}${type}`
      }).join('')
      const rule = entry.node.fields?.length
        ? `<line x1="${entry.x + 18}" y1="${fieldsStart - 14}" x2="${entry.x + entry.width - 18}" y2="${fieldsStart - 14}" stroke="#ebe7e1"/>`
        : ''
      return `<g><rect x="${entry.x}" y="${entry.y}" width="${entry.width}" height="${entry.height}" rx="16" fill="#ffffff" stroke="#d8d3cc"/><rect x="${entry.x}" y="${entry.y}" width="5" height="${entry.height}" rx="2.5" fill="${accent}"/><circle cx="${entry.x + 24}" cy="${entry.y + 28}" r="8" fill="${accent}" opacity="0.9"/>${text(entry.node.label, entry.x + 42, titleY, 'node-title')}${subtitle}${rule}${fields}</g>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${renderedWidth}" height="${renderedHeight}" viewBox="${minX - padding} ${minY - padding} ${viewWidth} ${viewHeight}" role="img"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8d8780"/></marker><style>.group-title,.node-title,.subtitle,.field-name,.field-type,.edge-label{font-family:Inter,Arial,sans-serif}.group-title{font-size:16px;font-weight:650;fill:#4b4742}.node-title{font-size:15px;font-weight:650;fill:#292622}.subtitle{font-size:11px;fill:#77716a}.field-name{font-size:11px;fill:#4b4742}.field-type{font-size:10px;fill:#8d8780}.edge-label{font-size:10px;fill:#615c56;text-anchor:middle}</style></defs><rect x="${minX - padding}" y="${minY - padding}" width="${viewWidth}" height="${viewHeight}" fill="#ffffff"/>${groups}${edges}${cards}</svg>`
}
