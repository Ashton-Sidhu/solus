import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const components = 'packages/workspace-ui/src/components'
const pane = source(`${components}/layout/WorkspaceBody.svelte`)
const guest = source('apps/desktop/src/renderer/shell/BrowserWebviewLayer.svelte')
const paneLayer = Number(pane.match(/\.secondary-pane-content--maximized\s*\{[^}]*z-index:\s*(\d+)/)?.[1])
const guestLayer = Number(guest.match(/placement.layer === "maximized" \? (\d+)/)?.[1])

describe('expanded panes stay below shared overlays', () => {
  test('the native browser page stays above its pane', () => {
    expect(paneLayer).toBeGreaterThan(0)
    expect(guestLayer).toBeGreaterThan(paneLayer)
  })

  // These portals leave the pane's stacking context. Their shared defaults must
  // clear both the pane and the native guest without per-button overrides.
  for (const name of [
    'popover/popover-content',
    'select/select-content',
    'dropdown-menu/dropdown-menu-content',
    'dropdown-menu/dropdown-menu-sub-content',
    'context-menu/context-menu-content',
    'context-menu/context-menu-sub-content',
    'tooltip/tooltip-content',
  ]) {
    test(`${name} clears expanded content`, () => {
      const content = source(`${components}/ui/${name}.svelte`)
      const overlayLayer = Number(content.match(/z-\[(\d+)\]/)?.[1])
      expect(overlayLayer).toBeGreaterThan(guestLayer)
    })
  }
})
