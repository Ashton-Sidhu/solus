import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const renderer = join(import.meta.dir, '../../src/renderer')

function readRendererFile(path: string): string {
  return readFileSync(join(renderer, path), 'utf8')
}

function svelteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...svelteFiles(full))
    else if (entry.endsWith('.svelte')) out.push(full)
  }
  return out
}

describe('pane chrome document order', () => {
  // WHY: Electron collects -webkit-app-region rects in DOM order and applies
  // them union-then-subtract in that same order. A `workspace-titlebar` drag
  // row rendered after PaneChrome's no-drag cluster re-covers its holes, and
  // every click on close/maximize becomes a window move. The cluster is
  // absolutely positioned, so rendering it last changes nothing visually.

  test('no drag row follows PaneChrome within a file', () => {
    for (const file of svelteFiles(join(renderer, 'components'))) {
      const source = readFileSync(file, 'utf8')
      const chromeIdx = source.indexOf('<PaneChrome')
      if (chromeIdx === -1) continue
      const lastTitlebarIdx = source.lastIndexOf('workspace-titlebar')
      if (lastTitlebarIdx === -1) continue
      expect(
        lastTitlebarIdx < chromeIdx,
        `${file}: a workspace-titlebar drag row renders after <PaneChrome> and will swallow its clicks`,
      ).toBe(true)
    }
  })

  test('hosts whose drag row lives in a child surface render PaneChrome last', () => {
    // WHY: these hosts lazy-load a surface that draws its own
    // `workspace-titlebar` row (DiffToolbar, FilesPane, DocumentShell, …), so
    // the same-file scan above cannot see the row. The chrome must still come
    // after the content that carries it.
    const hosts = [
      'components/diff/DiffPane.svelte',
      'components/files/FilesTreePane.svelte',
      'components/files/FileEditorHostPane.svelte',
      'components/conversation/SubagentHostPane.svelte',
      'components/work/WorkPane.svelte',
      'components/automations/AutomationPane.svelte',
      'components/plan/PlanPane.svelte',
    ]
    for (const host of hosts) {
      const source = readRendererFile(host)
      const chromeIdx = source.lastIndexOf('<PaneChrome')
      const lastAwaitIdx = source.lastIndexOf('{#await')
      expect(chromeIdx, `${host}: expected a <PaneChrome> render`).toBeGreaterThan(-1)
      expect(
        lastAwaitIdx < chromeIdx,
        `${host}: <PaneChrome> must render after the lazy surface that draws the drag row`,
      ).toBe(true)
    }
  })
})
