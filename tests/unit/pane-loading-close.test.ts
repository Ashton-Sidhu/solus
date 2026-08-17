import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const paneSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/ui/Pane.svelte'),
  'utf8',
)

describe('pane loading close control', () => {
  test('keeps overlays dismissible while their route module loads', () => {
    // WHY: the file explorer and file editor load behind this async boundary.
    // Their close control must not wait for the route module to resolve.
    expect(paneSource).toMatch(
      /{#await descriptor\.component\(\)}[\s\S]*descriptor\.placement === "overlay"[\s\S]*<PaneChrome[\s\S]*onClose={actions\.closeOverlay}/,
    )
  })
})
