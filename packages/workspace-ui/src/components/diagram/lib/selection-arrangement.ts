import type { Node } from '@xyflow/svelte'
import { absoluteBox, sizeStyle } from './graph-layout'

export type Arrangement = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'horizontal' | 'vertical' | 'width' | 'height'
/** A selected parent carries its children; never move a selected child twice. */
export function arrangementSelection(nodes: Node[]): Node[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return nodes.filter(n => {
    if (!n.selected || n.hidden) return false
    let parent = n.parentId ? byId.get(n.parentId) : undefined
    while (parent) { if (parent.selected) return false; parent = parent.parentId ? byId.get(parent.parentId) : undefined }
    return true
  })
}
export function arrangeNodes(nodes: Node[], action: Arrangement): Node[] {
  const selected = arrangementSelection(nodes)
  if (selected.length < (action === 'horizontal' || action === 'vertical' ? 3 : 2)) return nodes
  const byId = new Map(nodes.map(n => [n.id, n]))
  const items = selected.map(node => ({ node, box: { ...absoluteBox(node, byId), w: node.measured?.width ?? node.width ?? 192, h: node.measured?.height ?? node.height ?? 56 } }))
  const minX = Math.min(...items.map(n => n.box.x)), maxX = Math.max(...items.map(n => n.box.x + n.box.w))
  const minY = Math.min(...items.map(n => n.box.y)), maxY = Math.max(...items.map(n => n.box.y + n.box.h))
  const positions = new Map<string, { x: number; y: number }>()
  if (action === 'horizontal' || action === 'vertical') {
    const axis = action === 'horizontal' ? 'x' : 'y', size = axis === 'x' ? 'w' : 'h'
    items.sort((a, b) => a.box[axis] - b.box[axis] || a.node.id.localeCompare(b.node.id))
    const first = items[0].box[axis], last = items.at(-1)!
    const gap = Math.max(0, (last.box[axis] + last.box[size] - first - items.reduce((sum, n) => sum + n.box[size], 0)) / (items.length - 1))
    let cursor = first
    for (const { node, box } of items) {
      positions.set(node.id, { ...node.position, [axis]: node.position[axis] + cursor - box[axis] })
      cursor += box[size] + gap
    }
  } else {
    for (const { node, box } of items) {
      const x = action === 'left' ? minX : action === 'right' ? maxX - box.w : action === 'center' ? (minX + maxX - box.w) / 2 : box.x
      const y = action === 'top' ? minY : action === 'bottom' ? maxY - box.h : action === 'middle' ? (minY + maxY - box.h) / 2 : box.y
      positions.set(node.id, { x: node.position.x + x - box.x, y: node.position.y + y - box.y })
    }
  }
  const width = Math.max(...items.map(n => n.box.w)), height = Math.max(...items.map(n => n.box.h))
  return nodes.map(node => {
    const position = positions.get(node.id)
    if (!position) return node
    if (action === 'width' || action === 'height') {
      const w = action === 'width' ? width : node.measured?.width ?? node.width ?? 192
      const h = action === 'height' ? height : node.measured?.height ?? node.height ?? 56
      return { ...node, width: w, height: h, style: sizeStyle(w, h), data: { ...node.data, width: w, height: h } }
    }
    return { ...node, position }
  })
}
