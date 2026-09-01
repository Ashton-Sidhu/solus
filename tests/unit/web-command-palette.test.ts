import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const app = readFileSync(
  join(import.meta.dir, '../../apps/client/src/App.svelte'),
  'utf8',
)

describe('web command palette', () => {
  test('mounts the palette and registers its global shortcut', () => {
    // WHY: the web shell does not mount the desktop App component. A shortcut
    // registered only there is accepted by the dispatcher but shows nothing.
    expect(app).toContain('useKeybinding("global.command-palette"')
    expect(app).toContain('<CommandPalette bind:open={commandPaletteOpen}')
  })

  test('offers transport-neutral navigation commands', () => {
    expect(app).toContain('id: "open-project"')
    expect(app).toContain('id: "workspace"')
    expect(app).toContain('id: "tasks"')
    expect(app).toContain('id: "browser"')
  })
})
