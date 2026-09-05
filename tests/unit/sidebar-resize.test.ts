import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../../packages/workspace-ui/src/components/layout/WorkspaceBody.svelte', import.meta.url),
  'utf8',
)
const handle = source.match(/<Resizable\.Handle\s+aria-label="Resize sidebar"[\s\S]*?\/>/)?.[0]

describe('sidebar resize lifecycle', () => {
  test('keeps the release listeners enabled when a drag collapses the sidebar', () => {
    // PaneForge removes its mouseup/touchend listeners if disabled changes
    // during a drag, leaving its global cursor and drag state stuck.
    expect(handle).toContain('disabled={!sidebarOpen && !isResizingSidebar}')
    expect(handle).toContain('onDraggingChange={(dragging) => (isResizingSidebar = dragging)}')
    expect(source).toContain('let isResizingSidebar = $state(false)')
  })

  test('keeps the collapsed handle out of hit testing after release', () => {
    // Finishing a drag must not leave an invisible resize target over content.
    expect(handle).toContain('!sidebarOpen ? "pointer-events-none opacity-0" : ""')
  })
})
