import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

function read(path: string): string {
  return readFileSync(join(import.meta.dir, '../..', path), 'utf8')
}

const documentShell = read(
  'packages/workspace-ui/src/components/document-shell/DocumentShell.svelte',
)
const workspaceBody = read(
  'packages/workspace-ui/src/components/layout/WorkspaceBody.svelte',
)

describe('web iPad landscape chrome', () => {
  test('uses the compact Works toolbar from the pane width', () => {
    // WHY: an iPad landscape viewport is wide, but its secondary pane is not.
    // A viewport-only mobile check lets the desktop action row crush the title.
    expect(documentShell).toContain(
      'isMobile || (shellWidth > 0 && shellWidth < 40 * 16)',
    )
    expect(documentShell).toContain('{#if !compactToolbar}')
  })

  test('centres the web sidebar expand control on the breadcrumb row', () => {
    // WHY: desktop traffic-light geometry is three pixels above the web
    // breadcrumb row and must apply only to an inset native title bar.
    expect(workspaceBody).toContain('windowCtx.hasInsetTitlebar')
    expect(workspaceBody).toContain("'top-1 h-[2.875rem] items-center'")
  })
})
