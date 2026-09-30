import { afterAll, describe, expect, test } from 'bun:test'
import type { DiagramDoc } from '@solus/contracts/diagram-types'
import { parseDiagram } from '@solus/contracts/diagram-types'
import type { DiagramDocument as DiagramDocumentType } from '@solus/workspace-ui/components/diagram/lib/diagram-document'
import { SvelteRunes } from './helpers/svelte-runes'

// The model keeps undo in the rune-backed history, so both run on Svelte's
// real client runtime, as they do in the app.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const contracts = {
  '@solus/contracts/diagram-types': SvelteRunes.file('packages/contracts/src/diagram-types.ts'),
  '@solus/contracts/diagram-layout': SvelteRunes.file('packages/contracts/src/diagram-layout.ts'),
}
const history = runes.source('diagram-history', 'packages/workspace-ui/src/components/diagram/lib/diagram-history.svelte.ts', contracts)
const modelPath = runes.source('diagram-document', 'packages/workspace-ui/src/components/diagram/lib/diagram-document.ts', {
  ...contracts,
  './diagram-history.svelte': history,
})
const { DiagramDocument } = (await import(modelPath)) as { DiagramDocument: typeof DiagramDocumentType }

function fixture(): DiagramDoc {
  return {
    nodes: [
      {
        id: 'api', label: 'API', position: { x: 0, y: 0 }, icon: 'service', color: '#c96',
        fields: [{ name: 'id', type: 'uuid', key: 'pk' }], meta: { owner: 'core' }, badges: ['beta'],
        actions: [{ on: 'click', action: { do: 'drilldown' } }],
        detail: {
          nodes: [
            { id: 'handler', label: 'Handler', position: { x: 0, y: 0 } },
            { id: 'store', label: 'Store', position: { x: 300, y: 0 } },
          ],
          edges: [{ id: 'write', source: 'handler', target: 'store', kind: 'data' }],
        },
      },
      { id: 'zone', label: 'Zone', group: true, position: { x: 400, y: 100 }, width: 320, height: 220 },
      { id: 'db', label: 'DB', parentId: 'zone', position: { x: 20, y: 60 } },
      { id: 'queue', label: 'Queue', position: { x: 0, y: 400 } },
    ],
    edges: [
      { id: 'api-db', source: 'api', target: 'db', label: 'reads', dash: 'dotted', labelOffset: { x: 4, y: 5 } },
      { id: 'api-queue', source: 'api', target: 'queue', kind: 'async' },
    ],
  }
}

function open(doc = fixture()) {
  const changes: string[] = []
  const diagram = new DiagramDocument(doc, (change) => changes.push(change))
  return { diagram, changes }
}

describe('DiagramDocument', () => {
  test('a node edit changes only what it names and keeps every other field', () => {
    const { diagram } = open()
    diagram.updateNode([], 'api', { label: 'Gateway', subtitle: 'edge' })
    const api = diagram.node([], 'api')!
    expect(api.label).toBe('Gateway')
    expect(api.subtitle).toBe('edge')
    expect(api.fields).toEqual([{ name: 'id', type: 'uuid', key: 'pk' }])
    expect(api.meta).toEqual({ owner: 'core' })
    expect(api.actions).toEqual([{ on: 'click', action: { do: 'drilldown' } }])
    expect(api.detail?.nodes.map((n) => n.id)).toEqual(['handler', 'store'])
    // Clearing a field removes it rather than saving an undefined value.
    diagram.updateNode([], 'api', { color: undefined })
    expect('color' in diagram.node([], 'api')!).toBe(false)
    // Identity and placement do not travel through a content edit.
    // SAFETY: a caller holding a loose patch is exactly what this guards against.
    diagram.updateNode([], 'api', { id: 'other', position: { x: 9, y: 9 } } as never)
    expect(diagram.node([], 'api')!.position).toEqual({ x: 0, y: 0 })
  })

  test('an unchanged node keeps its identity so a projection can reuse it', () => {
    const { diagram } = open()
    const queue = diagram.node([], 'queue')
    diagram.moveNode([], 'api', { x: 10, y: 20 })
    expect(diagram.node([], 'queue')).toBe(queue)
    expect(diagram.node([], 'api')!.position).toEqual({ x: 10, y: 20 })
  })

  test('removing a node removes the edges that touch it', () => {
    const { diagram } = open()
    diagram.removeNode([], 'queue')
    expect(diagram.root.edges.map((e) => e.id)).toEqual(['api-db'])
    diagram.removeElements([], ['db'], ['api-queue'])
    expect(diagram.root.edges).toEqual([])
  })

  test('removing a group keeps its children where they were drawn', () => {
    const { diagram } = open()
    diagram.removeNode([], 'zone')
    const db = diagram.node([], 'db')!
    expect(db.parentId).toBeUndefined()
    expect(db.position).toEqual({ x: 420, y: 160 })
    expect(diagram.root.edges.map((e) => e.id)).toEqual(['api-db', 'api-queue'])
  })

  test('nesting lands only in a group and never inside the node itself', () => {
    const { diagram } = open()
    diagram.setParent([], 'queue', 'zone', { x: 30, y: 70 })
    expect(diagram.node([], 'queue')).toMatchObject({ parentId: 'zone', position: { x: 30, y: 70 } })
    diagram.setParent([], 'queue', 'api', { x: 1, y: 1 })
    expect(diagram.node([], 'queue')!.parentId).toBe('zone')
    // Nesting the group in its own child would close a cycle; that move is dropped.
    diagram.setParent([], 'zone', 'db', { x: 0, y: 0 })
    expect(diagram.node([], 'zone')!.parentId).toBeUndefined()
    diagram.setParent([], 'queue', null, { x: 430, y: 170 })
    expect(diagram.node([], 'queue')!.parentId).toBeUndefined()
    diagram.resizeNode([], 'zone', { width: 500, height: 300 }, { x: 390, y: 90 })
    expect(diagram.node([], 'zone')).toMatchObject({ width: 500, height: 300, position: { x: 390, y: 90 } })
  })

  test('an edit in a detail addresses its node and leaves the rest of the document alone', () => {
    const { diagram } = open()
    const root = diagram.root
    const queue = diagram.node([], 'queue')
    diagram.updateNode(['api'], 'handler', { label: 'Route handler' })
    diagram.updateEdge(['api'], 'write', { label: 'persist' })
    diagram.addNode(['api'], { id: 'cache', label: 'Cache', position: { x: 0, y: 200 }, detail: { nodes: [], edges: [] } })
    diagram.addEdge(['api'], { id: 'miss', source: 'handler', target: 'cache' })
    const detail = diagram.view(['api'])
    expect(detail.nodes.map((n) => n.label)).toEqual(['Route handler', 'Store', 'Cache'])
    expect(detail.edges.map((e) => [e.id, e.label])).toEqual([['write', 'persist'], ['miss', undefined]])
    // Detail stays one level deep.
    expect(diagram.node(['api'], 'cache')!.detail).toBeUndefined()
    expect(diagram.node([], 'queue')).toBe(queue)
    expect(diagram.node([], 'api')!.fields).toEqual([{ name: 'id', type: 'uuid', key: 'pk' }])
    // The view read before the edits still describes the document it was read from.
    expect(root.nodes[0].detail?.nodes[0].label).toBe('Handler')
  })

  test('the first node in an empty detail creates it, and removing the last drops it', () => {
    const { diagram } = open()
    expect(diagram.view(['queue']).nodes).toEqual([])
    diagram.addNode(['queue'], { id: 'worker', label: 'Worker', position: { x: 0, y: 0 } })
    expect(diagram.node([], 'queue')!.detail?.nodes.map((n) => n.id)).toEqual(['worker'])
    diagram.removeNode(['queue'], 'worker')
    expect(diagram.node([], 'queue')!.detail).toBeUndefined()
    diagram.removeDetail('api')
    expect(diagram.node([], 'api')!.detail).toBeUndefined()
  })

  test('edges connect only nodes of their level and reconnect to new ends', () => {
    const { diagram } = open()
    expect(diagram.addEdge([], { id: 'bad', source: 'api', target: 'handler' })).toBe(false)
    diagram.reconnectEdge([], 'api-db', { source: 'queue', target: 'db', targetHandle: 'left-target' })
    expect(diagram.edge([], 'api-db')).toMatchObject({ source: 'queue', target: 'db', targetHandle: 'left-target', label: 'reads', dash: 'dotted' })
    diagram.reconnectEdge([], 'api-db', { source: 'queue', target: 'api' })
    expect('targetHandle' in diagram.edge([], 'api-db')!).toBe(false)
    diagram.removeEdge([], 'api-db')
    expect(diagram.edge([], 'api-db')).toBeUndefined()
  })

  test('a grouped drag is one undo step, and redo puts it back', () => {
    const { diagram, changes } = open()
    diagram.edit(() => {
      diagram.moveNode([], 'api', { x: 50, y: 50 })
      diagram.moveNode([], 'queue', { x: 50, y: 450 })
      diagram.setParent([], 'queue', 'zone', { x: 10, y: 60 })
    })
    expect(changes).toEqual(['edit'])
    expect(diagram.canUndo).toBe(true)
    expect(diagram.undo()).toEqual([])
    expect(diagram.node([], 'api')!.position).toEqual({ x: 0, y: 0 })
    expect(diagram.node([], 'queue')).toMatchObject({ position: { x: 0, y: 400 } })
    expect(diagram.node([], 'queue')!.parentId).toBeUndefined()
    expect(diagram.canUndo).toBe(false)
    expect(diagram.canRedo).toBe(true)
    expect(diagram.redo()).toEqual([])
    expect(diagram.node([], 'queue')).toMatchObject({ parentId: 'zone', position: { x: 10, y: 60 } })
    expect(changes).toEqual(['edit', 'undo', 'redo'])
  })

  test('undo returns to the level where the edit happened', () => {
    const { diagram } = open()
    diagram.moveNode(['api'], 'store', { x: 320, y: 40 })
    expect(diagram.undo()).toEqual(['api'])
    expect(diagram.node(['api'], 'store')!.position).toEqual({ x: 300, y: 0 })
  })

  test('a command that changes nothing records nothing', () => {
    const { diagram, changes } = open()
    diagram.moveNode([], 'api', { x: 0, y: 0 })
    diagram.updateNode([], 'missing', { label: 'x' })
    diagram.edit(() => {})
    expect(changes).toEqual([])
    expect(diagram.canUndo).toBe(false)
  })

  test('laying out a level for the first time is saved but is not an undo step', () => {
    const doc = fixture()
    doc.nodes[0].detail = { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ id: 'ab', source: 'a', target: 'b' }] }
    const { diagram, changes } = open(doc)
    expect(diagram.normalizeView(['api'])).toBe(true)
    expect(diagram.view(['api']).nodes.every((n) => n.position)).toBe(true)
    expect(changes).toEqual(['normalize'])
    expect(diagram.canUndo).toBe(false)
    expect(diagram.normalizeView(['api'])).toBe(false)
  })

  test('auto-layout moves nodes, drops manual bends and keeps content', () => {
    const doc = fixture()
    doc.edges[1].bendOffset = 40
    doc.edges[1].sourceHandle = 'right-source'
    const { diagram } = open(doc)
    diagram.applyLayout([], 'TB')
    const edge = diagram.edge([], 'api-queue')!
    expect(edge.bendOffset).toBeUndefined()
    expect(edge.sourceHandle).toBeUndefined()
    expect(edge.kind).toBe('async')
    expect(diagram.node([], 'api')!.detail?.nodes).toHaveLength(2)
    diagram.undo()
    expect(diagram.edge([], 'api-queue')!.bendOffset).toBe(40)
  })

  test('accepted outside content replaces the document and its obsolete undo', () => {
    const { diagram, changes } = open()
    diagram.moveNode([], 'api', { x: 5, y: 5 })
    diagram.replace({ nodes: [{ id: 'fresh', label: 'Fresh', position: { x: 0, y: 0 } }], edges: [] })
    expect(diagram.root.nodes.map((n) => n.id)).toEqual(['fresh'])
    expect(diagram.canUndo).toBe(false)
    expect(diagram.undo()).toBeNull()
    expect(changes).toEqual(['edit'])
  })

  test('snapshots and command inputs are detached from the model', () => {
    const { diagram } = open()
    const snapshot = diagram.snapshot()
    snapshot.nodes[0].label = 'Changed outside'
    snapshot.nodes[0].detail!.nodes.length = 0
    expect(diagram.node([], 'api')!.label).toBe('API')
    expect(diagram.view(['api']).nodes).toHaveLength(2)
    const badges = ['one']
    diagram.updateNode([], 'queue', { badges })
    badges.push('two')
    expect(diagram.node([], 'queue')!.badges).toEqual(['one'])
    const added = { id: 'new', label: 'New', position: { x: 1, y: 1 } }
    diagram.addNode([], added)
    added.position.x = 999
    expect(diagram.node([], 'new')!.position).toEqual({ x: 1, y: 1 })
  })

  test('serialization is the saved {nodes, edges} form, detail included', () => {
    const { diagram } = open()
    diagram.updateNode(['api'], 'store', { label: 'Postgres' })
    const saved = parseDiagram(diagram.serialize())
    expect(saved.nodes.find((n) => n.id === 'api')!.detail!.nodes[1].label).toBe('Postgres')
    expect(saved.edges[0]).toEqual({ id: 'api-db', source: 'api', target: 'db', label: 'reads', dash: 'dotted', labelOffset: { x: 4, y: 5 } })
    expect(Object.keys(JSON.parse(diagram.serialize()))).toEqual(['nodes', 'edges'])
  })
})
