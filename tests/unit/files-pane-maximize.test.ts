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

  test('the maximize tooltip names this pane’s own shortcut', () => {
    // WHY: The chrome used to hard-code the diff panel's ⌥M. In the files pane
    // ⌥M toggles the Markdown view, so a fixed hint would name a key that does
    // something else. The files binding ships unassigned, and an empty hint must
    // leave the tooltip with no shortcut at all rather than a wrong one.
    expect(paneChrome).toContain('comboHint(maximizeBinding)')
    expect(paneChrome).toContain('maximizeHint ? ` (${maximizeHint})` : ""')
    expect(filesTreePane).toContain('maximizeBinding="files-pane.maximize"')
    expect(comboHint('files-pane.maximize')).toBe('')
    expect(comboHint('diff-panel.maximize')).not.toBe('')
  })
})
