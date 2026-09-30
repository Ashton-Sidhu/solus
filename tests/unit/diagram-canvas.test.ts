import { afterAll, expect, test } from 'bun:test'
import type { Node } from '@xyflow/svelte'
import { parseDiagram, type DiagramDoc } from '@solus/contracts/diagram-types'
import type { DiagramDocument as DiagramDocumentType } from '@solus/workspace-ui/components/diagram/lib/diagram-document'
import type { DiagramCanvas as DiagramCanvasType } from '@solus/workspace-ui/components/diagram/lib/diagram-canvas.svelte'
import type { CanvasGestures as CanvasGesturesType } from '@solus/workspace-ui/components/diagram/lib/canvas-gestures.svelte'
import type { DiagramSaver as DiagramSaverType } from '@solus/workspace-ui/components/diagram/lib/diagram-save.svelte'
import { SvelteRunes } from './helpers/svelte-runes'

// The shell's editing path without its markup: the canvas controller and its
// gestures on Svelte's real runtime, over the real document and save status.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const lib = 'packages/workspace-ui/src/components/diagram/lib/'
const file = (path: string) => SvelteRunes.file(path)
const contracts = {
  '@solus/contracts/diagram-types': file('packages/contracts/src/diagram-types.ts'),
  '@solus/contracts/diagram-layout': file('packages/contracts/src/diagram-layout.ts'),
}
const history = runes.source('diagram-history', `${lib}diagram-history.svelte.ts`, contracts)
const documentModule = runes.source('diagram-document', `${lib}diagram-document.ts`, { ...contracts, './diagram-history.svelte': history })
const canvasModule = runes.source('diagram-canvas', `${lib}diagram-canvas.svelte.ts`, {
  './diagram-document': documentModule,
  '../diagram-flow-map': file('packages/workspace-ui/src/components/diagram/diagram-flow-map.ts'),
  './flow-builders': file(`${lib}flow-builders.ts`),
  './graph-layout': file(`${lib}graph-layout.ts`),
  './selection-arrangement': file(`${lib}selection-arrangement.ts`),
  './clipboard.svelte': file(`${lib}clipboard.svelte.ts`),
  './inspector-model': file(`${lib}inspector-model.ts`),
})
const gesturesModule = runes.source('canvas-gestures', `${lib}canvas-gestures.svelte.ts`, {
  './diagram-canvas.svelte': canvasModule,
  './graph-layout': file(`${lib}graph-layout.ts`),
})
const saveModule = runes.source('diagram-save', `${lib}diagram-save.svelte.ts`)
const { DiagramDocument } = (await import(documentModule)) as { DiagramDocument: typeof DiagramDocumentType }
const { DiagramCanvas } = (await import(canvasModule)) as { DiagramCanvas: typeof DiagramCanvasType }
const { CanvasGestures } = (await import(gesturesModule)) as { CanvasGestures: typeof CanvasGesturesType }
const { DiagramSaver } = (await import(saveModule)) as { DiagramSaver: typeof DiagramSaverType }

// Frames run at once: the tests assert what a gesture leaves behind.
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  callback(0)
  return 0
}

function fixture(): DiagramDoc {
  return {
    nodes: [
      {
        id: 'api', label: 'API', position: { x: 0, y: 0 }, meta: { owner: 'core' },
        actions: [{ on: 'click', action: { do: 'drilldown' } }],
        detail: {
          nodes: [
            { id: 'handler', label: 'Handler', position: { x: 0, y: 0 } },
            { id: 'store', label: 'Store', position: { x: 300, y: 0 } },
          ],
          edges: [{ id: 'write', source: 'handler', target: 'store' }],
        },
      },
      { id: 'zone', label: 'Zone', group: true, position: { x: 400, y: 100 }, width: 320, height: 220 },
      { id: 'queue', label: 'Queue', position: { x: 0, y: 400 } },
    ],
    edges: [{ id: 'api-queue', source: 'api', target: 'queue', kind: 'async' }],
  }
}

function openShell() {
  const saves: string[] = []
  const levels: (string | null)[] = []
  const saver: DiagramSaverType = new DiagramSaver({
    content: () => diagram.serialize(),
    save: async (content) => { saves.push(content) },
  })
  const diagram: DiagramDocumentType = new DiagramDocument(fixture(), () => saver.schedule())
  const calls: string[] = []
  const updateNode = diagram.updateNode.bind(diagram)
  const placeNodes = diagram.placeNodes.bind(diagram)
  const addEdge = diagram.addEdge.bind(diagram)
  diagram.updateNode = (...args) => (calls.push('updateNode'), updateNode(...args))
  diagram.placeNodes = (...args) => (calls.push('placeNodes'), placeNodes(...args))
  diagram.addEdge = (...args) => (calls.push('addEdge'), addEdge(...args))
  const nodeHandlers = { onLabelChange: (nodeId: string, label: string) => canvas.updateNode(nodeId, { label }) }
  const canvas: DiagramCanvasType = new DiagramCanvas({
    document: diagram,
    nodeHandlers,
    edgeHandlers: {},
    pinFor: () => null,
    onLevelChange: (selectedNodeId) => levels.push(selectedNodeId),
    initialLayout: null,
  })
  const gestures = new CanvasGestures(canvas, () => null)
  return { diagram, canvas, gestures, saver, saves, levels, calls }
}

/** What xyflow does while a node is dragged: move the drawn node only. */
function dragTo(canvas: DiagramCanvasType, gestures: CanvasGesturesType, nodeId: string, position: { x: number; y: number }) {
  const start = canvas.nodes.find((n) => n.id === nodeId)!
  gestures.dragStart(start)
  canvas.nodes = canvas.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n))
  const moved = canvas.nodes.find((n) => n.id === nodeId)!
  gestures.drag(moved)
  gestures.dragStop(moved)
}

function drawn(canvas: DiagramCanvasType, nodeId: string): Node {
  return canvas.nodes.find((n) => n.id === nodeId)!
}

test('a drag is one document command and one undo step; the canvas only redraws what moved', () => {
  const { diagram, canvas, gestures, calls } = openShell()
  const api = drawn(canvas, 'api')
  // Into the group: the drop nests the node, in the group's frame.
  dragTo(canvas, gestures, 'queue', { x: 450, y: 160 })
  expect(calls).toEqual(['placeNodes'])
  expect(diagram.node([], 'queue')).toMatchObject({ parentId: 'zone', position: { x: 50, y: 60 } })
  expect(drawn(canvas, 'queue').parentId).toBe('zone')
  expect(drawn(canvas, 'api')).toBe(api)
  // The drag lift is view state; the drop settles every node back to resting z.
  expect(canvas.nodes.every((n) => n.zIndex !== 10000)).toBe(true)
  expect(canvas.layoutPristine).toBe(false)

  canvas.undo()
  expect(diagram.canUndo).toBe(false)
  expect(diagram.node([], 'queue')!.parentId).toBeUndefined()
  expect(drawn(canvas, 'queue').position).toEqual({ x: 0, y: 400 })
  canvas.redo()
  expect(drawn(canvas, 'queue').parentId).toBe('zone')
})

test('edits made in a nested view reach the saved document', async () => {
  const { diagram, canvas, gestures, saver, saves, levels, calls } = openShell()
  canvas.updateNode('queue', { label: 'Jobs' })
  const undoBefore = diagram.canUndo

  canvas.drillInto('api')
  expect(canvas.path).toEqual(['api'])
  expect(canvas.drillPath).toEqual([{ id: 'api', label: 'API' }])
  expect(canvas.nodes.map((n) => n.id)).toEqual(['handler', 'store'])
  // The level mounts with its entry node selected; entering it is not an edit.
  expect(levels).toEqual(['handler'])
  expect(drawn(canvas, 'handler').selected).toBe(true)
  expect(diagram.canUndo).toBe(undoBefore)

  // The node card's inline rename, a new connection, and a drag.
  const onLabelChange = drawn(canvas, 'handler').data.onLabelChange as (id: string, label: string) => void
  onLabelChange('handler', 'Route handler')
  expect(gestures.beforeConnect({ source: 'store', target: 'handler', sourceHandle: null, targetHandle: 'left-target' })).toBe(false)
  dragTo(canvas, gestures, 'store', { x: 320, y: 80 })
  expect(calls).toEqual(['updateNode', 'updateNode', 'addEdge', 'placeNodes'])
  expect(canvas.edges.map((e) => e.id)).toHaveLength(2)

  saver.flush()
  const saved = parseDiagram(saves.at(-1)!)
  const detail = saved.nodes.find((n) => n.id === 'api')!.detail!
  expect(detail.nodes.map((n) => [n.id, n.label, n.position])).toEqual([
    ['handler', 'Route handler', { x: 0, y: 0 }],
    ['store', 'Store', { x: 320, y: 80 }],
  ])
  expect(detail.edges.find((e) => e.source === 'store')).toMatchObject({ target: 'handler', targetHandle: 'left-target' })
  expect(detail.edges.find((e) => e.source === 'store')!.sourceHandle).toBeUndefined()
  // Root content, including fields the canvas never draws, is untouched.
  expect(saved.nodes.find((n) => n.id === 'queue')!.label).toBe('Jobs')
  expect(saved.nodes.find((n) => n.id === 'api')!.meta).toEqual({ owner: 'core' })

  // Undo on this level keeps the reader here.
  canvas.undo()
  expect(canvas.path).toEqual(['api'])
  expect(drawn(canvas, 'store').position).toEqual({ x: 300, y: 0 })

  // Back out: the crumb reselects the node drilled from.
  canvas.drillTo(0)
  expect(canvas.path).toEqual([])
  expect(levels.at(-1)).toBe('api')
  expect(drawn(canvas, 'api').data.detail).toBeTruthy()
  saver.flush()
})

test('an undo made on another level takes the reader to it', () => {
  const { canvas } = openShell()
  canvas.drillInto('api')
  canvas.updateNode('store', { label: 'Postgres' })
  canvas.drillTo(0)
  canvas.undo()
  expect(canvas.path).toEqual(['api'])
  expect(drawn(canvas, 'store').data.label).toBe('Store')
})
