import { expect, test } from 'bun:test'
import { alignmentGuides, type AlignmentNode } from '@solus/workspace-ui/components/diagram/lib/alignment-guides'

const node = (id: string, x: number, y: number, extra: Partial<AlignmentNode> = {}): AlignmentNode =>
  ({ id, x, y, width: 100, height: 60, ...extra })

test('shows a center guide when two equal-height nodes line up during a drag', () => {
  expect(alignmentGuides([node('a', 0, 0), node('b', 200, 0, { dragging: true })], 1))
    .toEqual([{ axis: 'y', position: 30, start: -8, end: 308 }])
})

test('supports edge and center alignment for different node sizes', () => {
  const fixed = node('a', 0, 0)
  expect(alignmentGuides([fixed, node('b', 200, 0, { height: 100, dragging: true })], 1)[0].position).toBe(0)
  expect(alignmentGuides([fixed, node('b', 25, 200, { width: 50, dragging: true })], 1)[0])
    .toMatchObject({ axis: 'x', position: 50 })
})

test('uses a one-screen-pixel tolerance at different zoom levels', () => {
  const nodes = [node('a', 0, 0), node('b', 200, 1.5, { dragging: true })]
  expect(alignmentGuides(nodes, 0.5)).toHaveLength(1)
  expect(alignmentGuides(nodes, 2)).toHaveLength(0)
})

test('clears guides when the drag ends or alignment is lost', () => {
  expect(alignmentGuides([node('a', 0, 0), node('b', 200, 0)], 1)).toEqual([])
  expect(alignmentGuides([node('a', 0, 0), node('b', 200, 8, { dragging: true })], 1)).toEqual([])
})

test('ignores hidden nodes and the dragged group’s own children', () => {
  const nodes = [node('group', 0, 0, { dragging: true }), node('child', 0, 0, { parentId: 'group' }), node('hidden', 200, 0, { hidden: true })]
  expect(alignmentGuides(nodes, 1)).toEqual([])
})

test('aligns grouped nodes using absolute geometry, excluding their parent', () => {
  const nodes = [node('group', 400, 300, { width: 300, height: 200 }), node('child', 420, 340, { parentId: 'group', dragging: true }), node('free', 700, 340)]
  expect(alignmentGuides(nodes, 1)).toEqual([{ axis: 'y', position: 370, start: 412, end: 808 }])
})

test('uses the bounds of the moving selection and does not align it to itself', () => {
  const nodes = [node('a', 0, 0, { dragging: true }), node('b', 100, 0, { dragging: true }), node('reference', 50, 200)]
  expect(alignmentGuides(nodes, 1)).toEqual([{ axis: 'x', position: 100, start: -8, end: 268 }])
})
