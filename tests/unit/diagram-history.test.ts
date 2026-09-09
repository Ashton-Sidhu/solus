import { expect, test } from 'bun:test'
import { compileModule } from 'svelte/compiler'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('undo and redo restore the whole diagram and the view where the edit happened', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'diagram-history-'))
  try {
    const source = readFileSync(new URL('packages/workspace-ui/src/components/diagram/lib/diagram-history.svelte.ts', root), 'utf8')
    const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
    const compiled = compileModule(javascript, { generate: 'client', filename: 'diagram-history.svelte.js' }).js.code
      .replaceAll('svelte/internal/client', new URL('node_modules/svelte/src/internal/client/index.js', root).href)
      .replaceAll('@solus/contracts/diagram-types', new URL('packages/contracts/src/diagram-types.ts', root).href)
    const path = join(directory, 'history.mjs')
    writeFileSync(path, compiled)
    const { DiagramHistory } = await import(path)
    const initial = { nodes: [{ id: 'parent', label: 'Service', detail: { nodes: [{ id: 'child', label: 'Before' }], edges: [] } }], edges: [] }
    const history = new DiagramHistory(initial)
    const changed = structuredClone(initial)
    changed.nodes[0].detail.nodes[0].label = 'After'
    history.record(changed, 'parent')
    history.record(changed) // navigation and saving are not edits
    expect(history.canUndo).toBe(true)
    const undo = history.undo()
    expect(undo.viewId).toBe('parent')
    expect(undo.doc.nodes[0].detail.nodes[0].label).toBe('Before')
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)
    undo.doc.nodes[0].label = 'Unrelated mutation'
    expect(history.redo().doc.nodes[0].detail.nodes[0].label).toBe('After')
    expect(history.undo().doc.nodes[0].label).toBe('Service')
    history.record({ nodes: [], edges: [] })
    expect(history.canRedo).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
