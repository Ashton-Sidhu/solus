import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { readDiagramFromY, writeDiagramToY } from '@solus/contracts/diagram-live'
import type { DiagramDoc } from '@solus/contracts/diagram-types'
import { pathToFileURL } from 'node:url'
import type { DiagramDocument as DiagramDocumentType } from '@solus/workspace-ui/components/diagram/lib/diagram-document'
import type { DiagramLiveHistory as DiagramLiveHistoryType } from '@solus/workspace-ui/components/diagram/lib/diagram-live-history.svelte'
import { SvelteRunes } from './helpers/svelte-runes'

/**
 * The live model of a diagram (docs/plans/work-review-and-live-editing.md,
 * phase 3b): edits to different nodes merge, the same field has one winner on
 * every client, a position is one value, and an edge never outlives its node.
 */

const base: DiagramDoc = {
  nodes: [
    { id: 'api', label: 'API', position: { x: 0, y: 0 } },
    { id: 'db', label: 'DB', position: { x: 200, y: 0 }, detail: { nodes: [{ id: 'table', label: 'users', position: { x: 0, y: 0 } }], edges: [] } },
  ],
  edges: [{ id: 'e1', source: 'api', target: 'db', label: 'reads' }],
}

function docWith(diagram: DiagramDoc): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => writeDiagramToY(doc, diagram))
  return doc
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

function edit(doc: Y.Doc, change: (diagram: DiagramDoc) => void): void {
  const diagram = readDiagramFromY(doc)
  change(diagram)
  doc.transact(() => writeDiagramToY(doc, diagram))
}

describe('the live diagram model', () => {
  test('a diagram reads back as written, detail and order included', () => {
    expect(readDiagramFromY(docWith(base))).toEqual(base)
  })

  test('two people editing different nodes both keep their edits', () => {
    const alice = docWith(base)
    const bob = new Y.Doc()
    sync(alice, bob)
    edit(alice, (d) => { d.nodes[0]!.label = 'Gateway' })
    edit(bob, (d) => { d.nodes[1]!.position = { x: 300, y: 50 } })
    sync(alice, bob)
    for (const doc of [alice, bob]) {
      const diagram = readDiagramFromY(doc)
      expect(diagram.nodes.map((n) => [n.label, n.position])).toEqual([['Gateway', { x: 0, y: 0 }], ['DB', { x: 300, y: 50 }]])
    }
  })

  test('two drags of one node land on one of the two positions, never a mix', () => {
    const alice = docWith(base)
    const bob = new Y.Doc()
    sync(alice, bob)
    edit(alice, (d) => { d.nodes[0]!.position = { x: 10, y: 99 } })
    edit(bob, (d) => { d.nodes[0]!.position = { x: 77, y: 5 } })
    sync(alice, bob)
    const position = readDiagramFromY(alice).nodes[0]!.position
    expect(readDiagramFromY(bob).nodes[0]!.position).toEqual(position!)
    expect([{ x: 10, y: 99 }, { x: 77, y: 5 }]).toContainEqual(position!)
  })

  test('an edge whose node was deleted at the same time is dropped', () => {
    const alice = docWith(base)
    const bob = new Y.Doc()
    sync(alice, bob)
    edit(alice, (d) => { d.nodes = d.nodes.filter((n) => n.id !== 'db'); d.edges = [] })
    edit(bob, (d) => { d.edges.push({ id: 'e2', source: 'db', target: 'api' }) })
    sync(alice, bob)
    expect(readDiagramFromY(bob)).toEqual({ nodes: [base.nodes[0]!], edges: [] })
  })

  test('a node added between two others keeps its place, and a detail edit touches only that level', () => {
    const doc = docWith(base)
    let changes = 0
    doc.on('update', () => { changes += 1 })
    edit(doc, (d) => { d.nodes.splice(1, 0, { id: 'cache', label: 'Cache', position: { x: 100, y: 0 } }) })
    expect(readDiagramFromY(doc).nodes.map((n) => n.id)).toEqual(['api', 'cache', 'db'])
    edit(doc, (d) => { d.nodes[2]!.detail!.nodes[0]!.label = 'accounts' })
    expect(readDiagramFromY(doc).nodes[2]!.detail!.nodes[0]!.label).toBe('accounts')
    edit(doc, () => {})
    expect(changes).toBe(2)
  })
})

describe('undo in a live diagram', () => {
  test("undo reverses only the reader's own edit, never a teammate's", async () => {
    // The live history keeps its flags in runes: run it on Svelte's client runtime.
    const runes = new SvelteRunes()
    try {
      const yjs = pathToFileURL(Bun.resolveSync('yjs', process.cwd())).href
      const contracts = {
        yjs,
        '@solus/contracts/diagram-types': SvelteRunes.file('packages/contracts/src/diagram-types.ts'),
        '@solus/contracts/diagram-layout': SvelteRunes.file('packages/contracts/src/diagram-layout.ts'),
        '@solus/contracts/diagram-live': SvelteRunes.file('packages/contracts/src/diagram-live.ts'),
      }
      const history = runes.source('diagram-history', 'packages/workspace-ui/src/components/diagram/lib/diagram-history.svelte.ts', contracts)
      const livePath = runes.source('diagram-live-history', 'packages/workspace-ui/src/components/diagram/lib/diagram-live-history.svelte.ts', contracts)
      const modelPath = runes.source('diagram-document', 'packages/workspace-ui/src/components/diagram/lib/diagram-document.ts', { ...contracts, './diagram-history.svelte': history })
      const { DiagramDocument } = (await import(modelPath)) as { DiagramDocument: typeof DiagramDocumentType }
      const { DiagramLiveHistory } = (await import(livePath)) as { DiagramLiveHistory: typeof DiagramLiveHistoryType }

      const shared = docWith(base)
      const teammate = new Y.Doc()
      sync(shared, teammate)
      const changes: string[] = []
      const model: DiagramDocumentType = new DiagramDocument(readDiagramFromY(shared), (change) => changes.push(change), (initial) => new DiagramLiveHistory(shared, initial, (next) => model.adopt(next)))
      model.updateNode([], 'api', { label: 'Mine' })
      edit(teammate, (d) => { d.nodes[1]!.label = 'Theirs' })
      sync(teammate, shared)
      expect(model.root.nodes.map((n) => n.label)).toEqual(['Mine', 'Theirs'])
      model.undo()
      expect(model.root.nodes.map((n) => n.label)).toEqual(['API', 'Theirs'])
      expect(readDiagramFromY(shared).nodes.map((n) => n.label)).toEqual(['API', 'Theirs'])
      expect(changes).toEqual(['edit', 'remote', 'undo'])
    } finally {
      runes.dispose()
    }
  })
})
