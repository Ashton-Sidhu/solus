import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const renderer = join(import.meta.dir, '../../src/renderer')

function readRendererFile(path: string): string {
  return readFileSync(join(renderer, path), 'utf8')
}

describe('page chrome hit testing', () => {
  test('keeps every control inside a no-drag region clickable', () => {
    // WHY: Electron drag regions intercept pointer input. A no-drag wrapper is
    // not sufficient unless its child buttons also carve out no-drag regions.
    const css = readRendererFile('index.css')
    expect(css).toMatch(/\.no-drag,\s*\n\.no-drag \*\s*{\s*-webkit-app-region: no-drag;/)
  })

  test('marks floating and pull-request page controls as no-drag', () => {
    // WHY: these controls sit outside, or directly inside, draggable titlebar
    // rows. Expand and close must remain clickable on every hosted page view.
    const pageShell = readRendererFile('components/ui/PageShell.svelte')
    const paneChrome = readRendererFile('components/ui/PaneChrome.svelte')
    const pageChrome = readRendererFile('lib/page-chrome.ts')
    const prPanelHeader = readRendererFile('components/pr-review/PrPanelHeader.svelte')
    const prReviewPane = readRendererFile('components/pr-review/PrReviewPane.svelte')

    expect(pageShell).toContain('class="no-drag pointer-events-auto absolute right-2.5 top-2.5')
    expect(paneChrome).toContain('class="no-drag pointer-events-auto absolute right-2.5 top-0')
    expect(pageChrome).toContain("'no-drag pointer-events-auto relative inline-flex")
    expect(prPanelHeader).toContain('"no-drag pointer-events-auto flex size-[26px]')
    expect(prReviewPane).toContain('class="no-drag pointer-events-auto flex shrink-0 items-center gap-0.5"')
  })
})
