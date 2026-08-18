import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const workspaceBody = readFileSync(
  join(root, 'src/renderer/components/layout/WorkspaceBody.svelte'),
  'utf8',
)

describe('pane sizing ownership', () => {
  test('PaneForge owns pane widths, not a Solus store', () => {
    // WHY: widths used to live in PaneGeometryStore — a weight, a pixel width and
    // a "has the user dragged this" flag per pane, kept in sync by hand with the
    // layout PaneForge was already computing. autoSaveId restores the layout on
    // mount and writes every drag back, so none of that bookkeeping has to exist.
    expect(existsSync(join(root, 'src/renderer/contexts/workspace/routing/pane-geometry.store.svelte.ts'))).toBe(false)
    expect(workspaceBody).toContain('autoSaveId="solus-workspace-split"')
    expect(workspaceBody).toContain('autoSaveId="solus-workspace-rail"')
  })

  test('pane constraints stay fixed percentages', () => {
    // WHY: PaneForge keys a saved layout by the panes' constraints
    // (paneforge/dist/internal/utils/storage.js, getPaneKey). A constraint derived
    // from the live container width changes that key on every window resize, so
    // the layout silently fails to restore AND localStorage grows one dead entry
    // per window width. Percentages keep the key stable — and scale on their own.
    expect(workspaceBody).not.toContain('pixelsToPercent')
    expect(workspaceBody).not.toContain('percentToPixels')
    expect(workspaceBody).not.toContain('paneBoundsPercent')
  })

  test('only a new surface resets a pane it did not size itself', () => {
    // WHY: an unguarded reset effect runs after PaneForge restores the saved
    // layout and overwrites it with the default, which quietly turns persistence
    // into a no-op. The first measure has to stand.
    expect(workspaceBody).toContain('if (isFirstMeasure || maximizedPaneId !== null) return;')
  })
})
