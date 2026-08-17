import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { comboHint } from '../../src/renderer/lib/keybindings/manifest'

const filesTreePane = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/files/FilesTreePane.svelte'),
  'utf8',
)
const paneChrome = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/ui/PaneChrome.svelte'),
  'utf8',
)

describe('files pane maximize control', () => {
  test('the files pane can be maximized from its chrome', () => {
    // WHY: The files pane opens as a companion column, which is too narrow to
    // read a file in. Without a maximize control the only way to widen it is to
    // drag the pane divider every time.
    expect(filesTreePane).toContain('onToggleMaximize={pane.toggleMaximize}')
    expect(filesTreePane).toContain('maximized={pane.maximized}')
  })

  test('the maximize tooltip names the one key that works here', () => {
    // WHY: The files pane used to spend ⌥M on the Markdown view, so it had no
    // maximize key of its own and its tooltip had to stay silent. Now the shared
    // pane key reaches this pane like every other, and the tooltip must teach it
    // rather than leave the control looking pointer-only.
    expect(paneChrome).toContain('comboHint(maximizeBinding)')
    expect(paneChrome).toContain('maximizeHint ? ` (${maximizeHint})` : ""')
    expect(paneChrome).toContain('maximizeBinding = "pane.maximize"')
    expect(filesTreePane).not.toContain('maximizeBinding=')
    expect(comboHint('pane.maximize')).not.toBe('')
  })
})
