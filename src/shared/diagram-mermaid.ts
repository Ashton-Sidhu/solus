import type { DiagramDoc, DiagramEdge } from './diagram-types'

// Edge kind → Mermaid arrow. Mirrors the editor's visual encoding: async is
// dotted, data is thick.
const ARROW: Record<NonNullable<DiagramEdge['kind']> | 'default', string> = {
  sync: '-->',
  async: '-.->',
  data: '==>',
  default: '-->',
}

/** Mermaid ids must be identifier-safe; map arbitrary node ids to stable aliases. */
function safeId(id: string, seen: Map<string, string>): string {
  const existing = seen.get(id)
  if (existing) return existing
  const base = id.replace(/[^a-zA-Z0-9_]/g, '_') || 'n'
  let alias = base
  let i = 1
  const used = new Set(seen.values())
  while (used.has(alias)) alias = `${base}_${i++}`
  seen.set(id, alias)
  return alias
}

/** Escape a label for use inside Mermaid's `"..."` quoted text. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, '&quot;').replace(/\n/g, ' ').trim()
}

/**
 * Serialize a diagram to a Mermaid `flowchart LR` definition. All nodes are
 * emitted as labeled rectangles; edges carry their labels and kind-specific arrows.
 */
export function serializeMermaid(doc: DiagramDoc): string {
  const seen = new Map<string, string>()
  const lines: string[] = ['flowchart LR']

  for (const node of doc.nodes) {
    const alias = safeId(node.id, seen)
    lines.push(`  ${alias}["${escapeLabel(node.label)}"]`)
  }

  for (const edge of doc.edges) {
    // Skip edges whose endpoints aren't declared nodes — keeps output valid.
    if (!seen.has(edge.source) || !seen.has(edge.target)) continue
    const arrow = ARROW[edge.kind ?? 'default'] ?? ARROW.default
    const src = safeId(edge.source, seen)
    const tgt = safeId(edge.target, seen)
    const label = edge.label ? `|"${escapeLabel(edge.label)}"|` : ''
    lines.push(`  ${src} ${arrow}${label} ${tgt}`)
  }

  return lines.join('\n')
}
