import type { DiagramDoc } from '@solus/contracts/diagram-types'
export interface DiagramSearchResult { id: string; kind: 'node' | 'edge'; label: string; nodeIds: string[] }
export function searchDiagram(doc: DiagramDoc, query: string): DiagramSearchResult[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return []
  const includes = (values: (string | undefined)[]) => values.some(value => value?.toLocaleLowerCase().includes(q))
  const nodes: DiagramSearchResult[] = doc.nodes.filter(n => includes([n.label, n.subtitle, ...(n.fields ?? []).flatMap(f => [f.name, f.type, f.ref])])).map(n => ({ id: n.id, kind: 'node', label: n.label, nodeIds: [n.id] }))
  const edges: DiagramSearchResult[] = doc.edges.filter(e => includes([e.label])).map(e => ({ id: e.id, kind: 'edge', label: e.label ?? '', nodeIds: [e.source, e.target] }))
  return [...nodes, ...edges]
}
export function nextSearchIndex(index: number, count: number, step: number): number {
  return count ? ((index + step) % count + count) % count : -1
}
