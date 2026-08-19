import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const workspaceSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/layout/WorkspaceBody.svelte'),
  'utf8',
)

describe('workspace session sidebar chrome', () => {
  test('keeps the reopen button available beside a secondary pane', () => {
    // WHY: secondary content collapses the session sidebar to reclaim width.
    // The chrome must report the real collapsed state so the user still has a
    // visible way to reopen it.
    expect(workspaceSource).toContain(
      'frameChrome.sidebarOpen = active ? sidebarOpen : true;',
    )
    expect(workspaceSource).not.toContain('sidebarOpenForChrome')
  })

  test('lets an explicit sidebar choice outlive the automatic collapse', () => {
    // WHY: reading sidebarOpen as an effect dependency closes the sidebar again
    // as soon as the user presses its reopen button. The surface transition is
    // the only dependency; a direct user toggle also cancels auto-restoration.
    expect(workspaceSource).toMatch(
      /const sidebarOverlayOpen[\s\S]*?untrack\(\(\) => {[\s\S]*?if \(sidebarOpen\)/,
    )
    expect(workspaceSource).toMatch(
      /function toggleSidebar\(\) {[\s\S]*?sidebarClosedForOverlay = false;/,
    )
  })
})
