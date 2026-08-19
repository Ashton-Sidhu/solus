import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const breadcrumbSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/conversation/SessionBreadcrumb.svelte'),
  'utf8',
)
const asideShellSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/layout/AsidePaneShell.svelte'),
  'utf8',
)

describe('conversation pane header', () => {
  test('keeps pane actions in the shared breadcrumb header', () => {
    // WHY: controls appended by AsidePaneShell bypass the shared divider and
    // button geometry, which makes the two conversation headers look different.
    expect(asideShellSource).toContain('onProjectPanelToggle={toggleRail}')
    expect(asideShellSource).toContain('{onClose}')
    expect(asideShellSource).not.toContain('PAGE_ICON_BTN')
  })

  test('uses one divider rule for every trailing header action', () => {
    expect(breadcrumbSource).toContain('const hasTrailingActions = $derived(')
    expect(breadcrumbSource).toContain('{#if hasTrailingActions}')
    expect(breadcrumbSource).toContain('{#if onClose}')
  })
})
